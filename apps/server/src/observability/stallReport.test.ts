// @effect-diagnostics nodeBuiltinImport:off - writes real report files to a temp directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  fitStallReport,
  MAX_STALL_REPORT_BYTES,
  MAX_STALL_REPORT_FILES,
  persistStallReport,
} from "./StallRecorder.ts";
import { buildStallReport, classifyStall } from "./stallReport.ts";
import { SUMMARIZER_SOURCE, type ProfileSummary, type V8Profile } from "./stallWatchdogWorker.ts";
import type { WatchdogStall } from "./StallWatchdog.ts";

const summarizeProfile = new Function(`${SUMMARIZER_SOURCE}; return summarizeProfile;`)() as (
  profile: V8Profile,
  windowStartUs: number,
  topN: number,
  maxDepth: number,
) => ProfileSummary;

// root -> sweep -> readRows (the hot frame), plus an idle node.
const profile: V8Profile = {
  nodes: [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2, 5] },
    {
      id: 2,
      callFrame: {
        functionName: "runSweep",
        url: "file:///C:/Users/Ht/.personal-bots/releases/abc123/dist/bin.mjs?x=1",
        lineNumber: 9,
      },
      children: [3],
    },
    {
      id: 3,
      callFrame: { functionName: "readRows", url: "file:///C:/app/dist/bin.mjs", lineNumber: 41 },
    },
    { id: 5, callFrame: { functionName: "(idle)", url: "", lineNumber: -1 } },
  ],
  startTime: 1_000_000,
  endTime: 1_000_000 + 5_000_000,
  // Times (µs from start): 0.5 s idle, then 3 s in readRows, then 0.5 s idle again.
  samples: [5, 3, 3, 3, 3, 3, 3, 5],
  timeDeltas: [500_000, 500_000, 500_000, 500_000, 500_000, 500_000, 500_000, 500_000, 500_000],
};

describe("summarizeProfile", () => {
  it("names the hot frame and its stack, with file base names only", () => {
    const summary = summarizeProfile(profile, 0, 5, 6);
    expect(summary.topSelf[0]).toEqual({ frame: "readRows (bin.mjs:42)", ms: 3000 });
    expect(summary.topStacks[0]).toEqual({
      ms: 3000,
      frames: ["readRows (bin.mjs:42)", "runSweep (bin.mjs:10)"],
    });
    expect(summary.idleMs).toBe(1000);
    expect(JSON.stringify(summary)).not.toContain("Users");
    expect(JSON.stringify(summary)).not.toContain("x=1");
  });

  it("counts only samples from the window start", () => {
    const summary = summarizeProfile(profile, 1_000_000 + 2_000_000, 5, 6);
    expect(summary.topSelf[0]!.ms).toBe(2000);
    expect(summary.windowSamples).toBe(5);
  });
});

const base = {
  startedAt: 1_000_000,
  endedAt: 1_005_000,
  durationMs: 5000,
  cpuUserMs: 4200,
  cpuSystemMs: 300,
  cpuWallMs: 5200,
  summary: null,
} as const;

describe("classifyStall", () => {
  it("blames a synchronous statement that spans most of the stall", () => {
    const cause = classifyStall(base, {
      jobs: [],
      gc: [],
      ops: [{ kind: "sql", label: "SELECT * FROM t", ms: 4200, size: 9, at: 1_004_900 }],
    });
    expect(cause.kind).toBe("sqlite-statement");
    expect(cause.detail).toContain("SELECT * FROM t");
  });

  it("blames a file write", () => {
    const cause = classifyStall(base, {
      jobs: [],
      gc: [],
      ops: [{ kind: "fs", label: "server.trace.ndjson", ms: 3000, size: 5, at: 1_004_000 }],
    });
    expect(cause.kind).toBe("file-write");
  });

  it("ignores a short call and a call outside the stall", () => {
    const cause = classifyStall(base, {
      jobs: [],
      gc: [],
      ops: [
        { kind: "sql", label: "A", ms: 300, size: 1, at: 1_002_000 },
        { kind: "sql", label: "B", ms: 4000, size: 1, at: 900_000 },
      ],
    });
    expect(cause.kind).not.toBe("sqlite-statement");
  });

  it("blames garbage collection that fills the stall", () => {
    const cause = classifyStall(base, {
      jobs: [],
      ops: [],
      gc: [{ kind: "major", ms: 3200, at: 1_003_500 }],
    });
    expect(cause.kind).toBe("garbage-collection");
  });

  it("names the hot JavaScript frame when the profile has one", () => {
    const summary = summarizeProfile(profile, 0, 5, 6);
    const cause = classifyStall({ ...base, summary }, { jobs: [], ops: [], gc: [] });
    expect(cause).toEqual({
      kind: "javascript",
      detail: "main thread busy in readRows (bin.mjs:42) for 3000 of 4000 ms sampled",
    });
  });

  it("calls a stall with almost no CPU a paused process", () => {
    const cause = classifyStall(
      { ...base, cpuUserMs: 200, cpuSystemMs: 100 },
      { jobs: [], ops: [], gc: [] },
    );
    expect(cause.kind).toBe("process-paused");
  });
});

const watchdogStall: WatchdogStall = {
  ...base,
  profilerMode: "continuous",
  profileStartLatencyMs: null,
  profileStopLatencyMs: 12,
  profilerError: null,
  freeMemMb: 7000,
  rssMb: 350,
};

describe("buildStallReport", () => {
  it("lists jobs by how much of the stall they covered, as offsets", () => {
    const report = buildStallReport({
      stall: watchdogStall,
      context: {
        jobs: [
          { name: "job:short", startedAt: 1_000_100, endedAt: 1_000_900 },
          { name: "job:whole-stall", startedAt: 999_000, endedAt: null },
        ],
        ops: [],
        gc: [],
      },
      appVersion: "abc123",
      pid: 7,
      heapUsedMb: 100,
      heapLimitMb: 4000,
    });
    expect(report.jobs).toEqual([
      { name: "job:whole-stall", startOffsetMs: -1000, endOffsetMs: null },
      { name: "job:short", startOffsetMs: 100, endOffsetMs: 900 },
    ]);
    expect(report.startedAt).toBe("1970-01-01T00:16:40.000Z");
  });
});

const bigReport = () =>
  buildStallReport({
    stall: {
      ...watchdogStall,
      summary: {
        windowSamples: 1,
        windowMs: 1,
        idleMs: 0,
        programMs: 0,
        gcMs: 0,
        topSelf: [{ frame: "f (a.mjs:1)", ms: 1 }],
        topStacks: [{ ms: 1, frames: Array.from({ length: 12 }, () => "x".repeat(8000)) }],
      },
    },
    context: { jobs: [], ops: [], gc: [] },
    appVersion: "abc123",
    pid: 7,
    heapUsedMb: 1,
    heapLimitMb: 1,
  });

describe("stall report files", () => {
  it("cuts an oversized report below the byte cap", () => {
    const text = fitStallReport(bigReport());
    expect(text.length).toBeLessThanOrEqual(MAX_STALL_REPORT_BYTES);
    expect(JSON.parse(text).durationMs).toBe(5000);
  });

  it("keeps only the newest reports", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stall-reports-"));
    try {
      for (let index = 0; index < MAX_STALL_REPORT_FILES + 5; index++) {
        const report = buildStallReport({
          stall: { ...watchdogStall, startedAt: 1_000_000 + index * 60_000 },
          context: { jobs: [], ops: [], gc: [] },
          appVersion: "abc123",
          pid: 7,
          heapUsedMb: 1,
          heapLimitMb: 1,
        });
        await persistStallReport(dir, report);
      }
      const names = (await NodeFSP.readdir(dir)).sort();
      expect(names).toHaveLength(MAX_STALL_REPORT_FILES);
      // Report 5 is the oldest one left.
      expect(names[0]).toBe("stall-19700101T002140Z-5000ms.json");
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
