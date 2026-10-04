// @effect-diagnostics nodeBuiltinImport:off - node:fs/promises, perf_hooks, v8 and path have no Effect equivalent here.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeV8 from "node:v8";

import { noteGc, snapshotStallWindow, stallRecorderEnabled } from "@t3tools/shared/stallContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { buildStallReport, type StallReport } from "./stallReport.ts";
import {
  startStallWatchdog,
  stallProfilerModeFromEnv,
  type WatchdogStall,
} from "./StallWatchdog.ts";

/** `T3CODE_STALL_PROFILER`: `continuous` (default), `detect` (profile only once a stall starts) or `off`. */
const DEFAULT_PROFILER_MODE = "continuous" as const;
/** Reports kept on disk, oldest dropped first. */
export const MAX_STALL_REPORT_FILES = 20;
/** One report is cut down to this many bytes before it is written. */
export const MAX_STALL_REPORT_BYTES = 64 * 1024;
const GC_NOTE_MIN_MS = 50;

const GC_KINDS: Record<number, string> = {
  [NodePerfHooks.constants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [NodePerfHooks.constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [NodePerfHooks.constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [NodePerfHooks.constants.NODE_PERFORMANCE_GC_WEAKCB]: "weak-callbacks",
};

/** `.../releases/<sha>/dist/bin.mjs` names the release the server runs. */
const releaseName = () => {
  const match = /[\\/]releases[\\/]([^\\/]+)[\\/]/.exec(process.argv[1] ?? "");
  return match?.[1] ?? "unknown";
};

/** Keeps a report under the byte cap by dropping its bulkiest parts. */
export const fitStallReport = (report: StallReport): string => {
  let text = JSON.stringify(report, null, 1);
  if (text.length <= MAX_STALL_REPORT_BYTES) return text;
  const slim: StallReport = {
    ...report,
    profile: report.profile === null ? null : { ...report.profile, topStacks: [] },
  };
  text = JSON.stringify(slim, null, 1);
  if (text.length <= MAX_STALL_REPORT_BYTES) return text;
  return JSON.stringify({
    ...slim,
    profile: null,
    jobs: slim.jobs.slice(0, 4),
    ops: slim.ops.slice(0, 3),
  });
};

const reportFileName = (report: StallReport) =>
  `stall-${report.startedAt.replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${report.durationMs}ms.json`;

/** Writes the report and drops the oldest ones beyond the count cap. Returns the file path. */
export const persistStallReport = async (dir: string, report: StallReport): Promise<string> => {
  await NodeFSP.mkdir(dir, { recursive: true });
  const filePath = NodePath.join(dir, reportFileName(report));
  await NodeFSP.writeFile(filePath, fitStallReport(report), "utf8");
  const names = (await NodeFSP.readdir(dir))
    .filter((name) => name.startsWith("stall-") && name.endsWith(".json"))
    .sort();
  for (const name of names.slice(0, Math.max(0, names.length - MAX_STALL_REPORT_FILES))) {
    await NodeFSP.rm(NodePath.join(dir, name), { force: true });
  }
  return filePath;
};

/**
 * Names the cause of each event loop stall of 1 s or more. A worker thread watches a
 * heartbeat and, when the main thread stops answering, reads its CPU profile through
 * the inspector. The main thread keeps notes of the named jobs that ran, the slow
 * synchronous SQLite and file calls and the long garbage collections
 * (`@t3tools/shared/stallContext`). Each stall becomes one WARN log line and one small
 * JSON file under `<logs>/stalls` (or `T3CODE_PERSONAL_STALL_DIR`), 20 kept.
 *
 * Kill switches: `T3CODE_STALL_RECORDER=off` turns off everything (notes included);
 * `T3CODE_STALL_PROFILER=off|detect` turns off or defers the profiler only (`detect` does not
 * name functions that were already running, so it is a fallback); `T3CODE_STALL_SAMPLE_US`
 * sets the sampling interval (default 50,000 µs).
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!stallRecorderEnabled()) {
      yield* Effect.logInfo("stall recorder off (T3CODE_STALL_RECORDER)");
      return;
    }
    const { logsDir } = yield* ServerConfig.ServerConfig;
    const dir = process.env.T3CODE_PERSONAL_STALL_DIR?.trim() || NodePath.join(logsDir, "stalls");
    const profilerMode = stallProfilerModeFromEnv(
      process.env.T3CODE_STALL_PROFILER,
      DEFAULT_PROFILER_MODE,
    );
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const release = releaseName();

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const observer = new NodePerfHooks.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration < GC_NOTE_MIN_MS) continue;
            const kind = (entry as unknown as { detail?: { kind?: number } }).detail?.kind;
            noteGc(
              GC_KINDS[kind ?? -1] ?? "unknown",
              entry.duration,
              NodePerfHooks.performance.timeOrigin + entry.startTime + entry.duration,
            );
          }
        });
        observer.observe({ entryTypes: ["gc"] });
        return observer;
      }),
      (observer) => Effect.sync(() => observer.disconnect()),
    );

    const onStall = (stall: WatchdogStall) => {
      const heap = NodeV8.getHeapStatistics();
      const report = buildStallReport({
        stall,
        context: snapshotStallWindow(stall.startedAt, stall.endedAt),
        appVersion: release,
        pid: process.pid,
        heapUsedMb: Math.round(heap.used_heap_size / 1048576),
        heapLimitMb: Math.round(heap.heap_size_limit / 1048576),
      });
      runFork(
        Effect.gen(function* () {
          const file = yield* Effect.tryPromise(() => persistStallReport(dir, report)).pipe(
            Effect.orElseSucceed(() => null),
          );
          const topFrame = report.profile?.topSelf[0];
          yield* Effect.logWarning("event loop stall captured", {
            durationMs: report.durationMs,
            cause: report.cause.kind,
            detail: report.cause.detail,
            jobs: [...new Set(report.jobs.map((job) => job.name))].slice(0, 6),
            slowCalls: report.ops.slice(0, 3).map((op) => `${op.kind} ${op.ms} ms ${op.label}`),
            topFrame: topFrame === undefined ? null : `${topFrame.frame} ${topFrame.ms} ms`,
            cpuMs: report.cpu.userMs + report.cpu.systemMs,
            wallMs: report.cpu.wallMs,
            freeMemMb: report.memory.freeMemMb,
            file,
          }).pipe(
            Effect.withSpan("server.eventLoop.stallCapture", {
              root: true,
              level: "Warn",
              attributes: {
                durationMs: report.durationMs,
                causeKind: report.cause.kind,
                cause: report.cause.detail,
                jobCount: report.jobs.length,
                slowCallCount: report.ops.length,
              },
            }),
          );
        }),
      );
    };

    const watchdog = yield* Effect.acquireRelease(
      Effect.sync(() =>
        startStallWatchdog({
          profilerMode,
          sampleIntervalUs: Number(process.env.T3CODE_STALL_SAMPLE_US) || undefined,
          onStall,
          onError: (message) =>
            runFork(Effect.logWarning("stall watchdog error", { message: message.slice(0, 300) })),
        }),
      ),
      (watchdog) => Effect.promise(() => watchdog.stop()),
    );
    yield* Effect.logInfo("stall recorder on", {
      profiler: watchdog.profilerMode,
      dir,
      thresholdMs: 1000,
    });
  }),
);
