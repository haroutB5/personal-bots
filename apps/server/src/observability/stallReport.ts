import type { StallWindowContext } from "@t3tools/shared/stallContext";
import * as DateTime from "effect/DateTime";

import type { WatchdogStall } from "./StallWatchdog.ts";

/**
 * The record written for one stall: what the watchdog saw, what the notes say was
 * running, and the likely cause in one line. Labels and numbers only.
 */
export interface StallReport {
  readonly version: 1;
  readonly appVersion: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly cause: StallCause;
  readonly profiler: {
    readonly mode: WatchdogStall["profilerMode"];
    readonly startLatencyMs: number | null;
    readonly stopLatencyMs: number;
    readonly error: string | null;
  };
  readonly cpu: { readonly userMs: number; readonly systemMs: number; readonly wallMs: number };
  readonly memory: {
    readonly rssMb: number;
    readonly freeMemMb: number;
    readonly heapUsedMb: number;
    readonly heapLimitMb: number;
  };
  readonly jobs: ReadonlyArray<{
    readonly name: string;
    /** Start and end as ms from the stall's start; null end = still running. */
    readonly startOffsetMs: number;
    readonly endOffsetMs: number | null;
  }>;
  readonly ops: ReadonlyArray<{
    readonly kind: string;
    readonly label: string;
    readonly ms: number;
    readonly size: number;
    readonly endOffsetMs: number;
  }>;
  readonly gc: ReadonlyArray<{ readonly kind: string; readonly ms: number }>;
  readonly profile: WatchdogStall["summary"];
}

export type StallCauseKind =
  | "sqlite-statement"
  | "file-write"
  | "garbage-collection"
  | "javascript"
  | "process-paused"
  | "unknown";

export interface StallCause {
  readonly kind: StallCauseKind;
  /** One line a person can act on. */
  readonly detail: string;
}

const MAX_JOBS = 12;
const MAX_OPS = 10;
const MAX_GC = 10;

const overlapMs = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/**
 * Picks the most likely cause from what overlapped the stall. A synchronous call
 * that spans most of the stall wins, then garbage collection, then a stall in which
 * the process barely ran (CPU far below wall time), then the hottest JavaScript frame.
 */
export const classifyStall = (
  stall: Pick<
    WatchdogStall,
    "startedAt" | "endedAt" | "durationMs" | "cpuUserMs" | "cpuSystemMs" | "cpuWallMs" | "summary"
  >,
  context: StallWindowContext,
): StallCause => {
  const half = stall.durationMs * 0.5;
  let bestOp: { op: StallWindowContext["ops"][number]; overlap: number } | null = null;
  for (const op of context.ops) {
    const overlap = overlapMs(op.at - op.ms, op.at, stall.startedAt, stall.endedAt);
    if (bestOp === null || overlap > bestOp.overlap) bestOp = { op, overlap };
  }
  if (bestOp !== null && bestOp.overlap >= half) {
    const { op } = bestOp;
    return op.kind === "sql"
      ? {
          kind: "sqlite-statement",
          detail: `synchronous SQLite statement ${op.ms} ms: ${op.label}`,
        }
      : { kind: "file-write", detail: `synchronous file write ${op.ms} ms: ${op.label}` };
  }
  const gcMs = context.gc.reduce(
    (sum, entry) => sum + overlapMs(entry.at - entry.ms, entry.at, stall.startedAt, stall.endedAt),
    0,
  );
  if (gcMs >= half) {
    return { kind: "garbage-collection", detail: `garbage collection took ${Math.round(gcMs)} ms` };
  }
  const cpuMs = stall.cpuUserMs + stall.cpuSystemMs;
  const summary = stall.summary;
  if (summary !== null && summary.windowMs > 0) {
    const top = summary.topSelf.find(
      (entry) => !entry.frame.startsWith("(idle)") && !entry.frame.startsWith("(program)"),
    );
    if (top !== undefined && top.ms >= summary.windowMs * 0.4) {
      return {
        kind: "javascript",
        detail: `main thread busy in ${top.frame} for ${top.ms} of ${summary.windowMs} ms sampled`,
      };
    }
  }
  if (stall.cpuWallMs > 0 && cpuMs < stall.cpuWallMs * 0.25) {
    return {
      kind: "process-paused",
      detail: `process used ${cpuMs} ms CPU over ${stall.cpuWallMs} ms: starved or paused by the OS, or waiting on disk`,
    };
  }
  if (summary !== null && summary.topSelf.length > 0) {
    return {
      kind: "javascript",
      detail: `no single frame dominates; top: ${summary.topSelf
        .slice(0, 3)
        .map((entry) => `${entry.frame} ${entry.ms} ms`)
        .join("; ")}`,
    };
  }
  return { kind: "unknown", detail: "no profile and no overlapping synchronous call" };
};

export const buildStallReport = (input: {
  readonly stall: WatchdogStall;
  readonly context: StallWindowContext;
  readonly appVersion: string;
  readonly pid: number;
  readonly heapUsedMb: number;
  readonly heapLimitMb: number;
}): StallReport => {
  const { stall, context } = input;
  const offset = (epochMs: number) => Math.round(epochMs - stall.startedAt);
  const jobs = context.jobs
    .map((job) => ({
      name: job.name,
      startOffsetMs: offset(job.startedAt),
      endOffsetMs: job.endedAt === null ? null : offset(job.endedAt),
      overlap: overlapMs(
        job.startedAt,
        job.endedAt ?? stall.endedAt,
        stall.startedAt,
        stall.endedAt,
      ),
    }))
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, MAX_JOBS)
    .map(({ overlap: _overlap, ...rest }) => rest);
  return {
    version: 1,
    appVersion: input.appVersion,
    pid: input.pid,
    startedAt: DateTime.formatIso(DateTime.makeUnsafe(stall.startedAt)),
    endedAt: DateTime.formatIso(DateTime.makeUnsafe(stall.endedAt)),
    durationMs: stall.durationMs,
    cause: classifyStall(stall, context),
    profiler: {
      mode: stall.profilerMode,
      startLatencyMs: stall.profileStartLatencyMs,
      stopLatencyMs: stall.profileStopLatencyMs,
      error: stall.profilerError,
    },
    cpu: { userMs: stall.cpuUserMs, systemMs: stall.cpuSystemMs, wallMs: stall.cpuWallMs },
    memory: {
      rssMb: stall.rssMb,
      freeMemMb: stall.freeMemMb,
      heapUsedMb: input.heapUsedMb,
      heapLimitMb: input.heapLimitMb,
    },
    jobs,
    ops: [...context.ops]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, MAX_OPS)
      .map((op) => ({
        kind: op.kind,
        label: op.label,
        ms: op.ms,
        size: op.size,
        endOffsetMs: offset(op.at),
      })),
    gc: [...context.gc]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, MAX_GC)
      .map((entry) => ({ kind: entry.kind, ms: entry.ms })),
    profile: stall.summary,
  };
};
