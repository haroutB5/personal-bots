import { describe, expect, it } from "vite-plus/test";

import {
  noteCacheRead,
  noteCacheWrite,
  noteListCommit,
  noteRequestDone,
  noteRequestStart,
  takeChatOpenReport,
} from "./chatOpenPerf";

describe("chat open timings", () => {
  it("reports a chat painted from its saved copy, with the read and the request offset", () => {
    expect(
      noteCacheRead("t-cache", { at: 1040, ms: 38.4, decodeMs: 12.2, bytes: 1_084_708, hit: true }),
    ).toBe("[perf] cache-read-ms 38 bytes 1084708 decode-ms 12 hit");
    noteRequestStart("t-cache", 1050);

    expect(takeChatOpenReport("t-cache", 1000, 1120.6)).toEqual({
      line: "[perf] chat-open-ms 121 cache request-at-ms 50",
      body: {
        event: "perf",
        journey: "a-chat-open",
        ms: 121,
        store: "cache",
        requestAtMs: 50,
        readMs: 38,
        readBytes: 1_084_708,
      },
    });
  });

  it("counts a saved copy that arrived after the request left as a network open", () => {
    noteRequestStart("t-late", 2500);
    noteCacheRead("t-late", { at: 2900, ms: 900, decodeMs: 40, bytes: 900_000, hit: true });

    expect(takeChatOpenReport("t-late", 2000, 3100).line).toBe(
      "[perf] chat-open-ms 1100 network request-at-ms 500",
    );
  });

  it("names an open with no read and no request as memory, and ignores marks from an earlier open", () => {
    noteCacheRead("t-old", { at: 10, ms: 5, decodeMs: 1, bytes: 10, hit: true });
    noteRequestStart("t-old", 20);

    expect(takeChatOpenReport("t-old", 5000, 5030)).toEqual({
      line: "[perf] chat-open-ms 30 memory request-at-ms -",
      body: { event: "perf", journey: "a-chat-open", ms: 30, store: "memory" },
    });
  });

  it("times an open from its own first request after an earlier open never painted", () => {
    noteRequestStart("t-again", 100);
    noteRequestStart("t-again", 9_200);
    noteRequestStart("t-again", 9_900);

    expect(takeChatOpenReport("t-again", 9_000, 10_100).line).toBe(
      "[perf] chat-open-ms 1100 network request-at-ms 200",
    );
  });

  it("carries the slowest write since the last report on the next one only", () => {
    expect(noteCacheWrite({ ms: 12.4, jsMs: 4.2, bytes: 400_000 })).toBe(
      "[perf] cache-write-ms 12 bytes 400000 js-ms 4",
    );
    noteCacheWrite({ ms: 3100, jsMs: 60, bytes: 1_000_000 });
    noteCacheWrite({ ms: 40, jsMs: 30, bytes: 900_000 });
    noteRequestStart("t-write", 7100);

    expect(takeChatOpenReport("t-write", 7000, 7400).body).toEqual({
      event: "perf",
      journey: "a-chat-open",
      ms: 400,
      store: "network",
      requestAtMs: 100,
      writeMs: 3100,
      writeBytes: 1_000_000,
      writes: 3,
    });
    expect(takeChatOpenReport("t-write", 8000, 8050).body).toEqual({
      event: "perf",
      journey: "a-chat-open",
      ms: 50,
      store: "memory",
    });
  });
  it("measures an open from the tap too, and keeps ms from the mount", () => {
    noteRequestStart("t-tap", 1_130);
    noteRequestDone("t-tap", 1_130, { responseMs: 41.4, decodeMs: 16.6 });

    const report = takeChatOpenReport("t-tap", 1_100, 1_400, 900);

    expect(report.body).toEqual({
      event: "perf",
      journey: "a-chat-open",
      ms: 300,
      fromTapMs: 500,
      store: "network",
      requestAtMs: 30,
      responseMs: 41,
      decodeMs: 17,
    });
    expect(report.line).toBe("[perf] chat-open-ms 300 network request-at-ms 30 from-tap-ms 500");
  });

  it("never reports fromTapMs below ms, even when the tap time is later than the mount", () => {
    const report = takeChatOpenReport("t-skew", 2_000, 2_250, 2_040);

    expect(report.body.ms).toBe(250);
    expect(report.body.fromTapMs).toBe(250);
  });

  it("leaves out fromTapMs when no tap is known, as an open from a link does", () => {
    noteRequestStart("t-link", 3_080);

    expect(takeChatOpenReport("t-link", 3_000, 3_300).body).toEqual({
      event: "perf",
      journey: "a-chat-open",
      ms: 300,
      store: "network",
      requestAtMs: 80,
    });
  });

  it("counts a request that left at the tap as this open's own, and says it was a prefetch", () => {
    noteRequestStart("t-pre", 5_020, true);
    noteRequestDone("t-pre", 5_020, { responseMs: 38, decodeMs: 12 });

    expect(takeChatOpenReport("t-pre", 5_240, 5_420, 5_000).body).toEqual({
      event: "perf",
      journey: "a-chat-open",
      ms: 180,
      fromTapMs: 420,
      store: "network",
      requestAtMs: 0,
      prefetched: true,
      responseMs: 38,
      decodeMs: 12,
    });
  });

  it("ignores a request that left before the tap", () => {
    noteRequestStart("t-before", 4_000);

    expect(takeChatOpenReport("t-before", 9_100, 9_200, 9_000).body).toEqual({
      event: "perf",
      journey: "a-chat-open",
      ms: 100,
      fromTapMs: 200,
      store: "memory",
    });
  });

  it("ignores a list commit from before this open began", () => {
    noteListCommit("t-list-old", { at: 900, ms: 80, rows: 40 });

    expect(takeChatOpenReport("t-list-old", 1_000, 1_200).body).toEqual({
      event: "perf",
      journey: "a-chat-open",
      ms: 200,
      store: "memory",
    });
  });

  it("reports the first list commit after the open began as listMs and rows", () => {
    noteListCommit("t-list", { at: 1_150, ms: 96.4, rows: 31 });

    const report = takeChatOpenReport("t-list", 1_000, 1_300);

    expect(report.body).toEqual({
      event: "perf",
      journey: "a-chat-open",
      ms: 300,
      store: "memory",
      listMs: 96,
      rows: 31,
    });
    expect(report.line).toBe("[perf] chat-open-ms 300 memory request-at-ms - list-ms 96");
  });

  it("keeps the first list commit when a later one follows, and clears it once reported", () => {
    noteListCommit("t-list-two", { at: 2_100, ms: 70, rows: 12 });
    noteListCommit("t-list-two", { at: 2_400, ms: 25, rows: 13 });

    expect(takeChatOpenReport("t-list-two", 2_000, 2_500).body).toMatchObject({
      listMs: 70,
      rows: 12,
    });
    expect(takeChatOpenReport("t-list-two", 3_000, 3_100).body).not.toHaveProperty("listMs");
  });

  it("leaves out listMs and rows when the list never committed rows", () => {
    const report = takeChatOpenReport("t-list-none", 4_000, 4_120);

    expect(report.body).not.toHaveProperty("listMs");
    expect(report.body).not.toHaveProperty("rows");
    expect(report.line).not.toContain("list-ms");
  });

  it("puts list-ms after from-tap-ms on the line only when the body has it", () => {
    noteListCommit("t-list-tap", { at: 5_300, ms: 41, rows: 8 });

    expect(takeChatOpenReport("t-list-tap", 5_200, 5_400, 5_100).line).toBe(
      "[perf] chat-open-ms 200 memory request-at-ms - from-tap-ms 300 list-ms 41",
    );
  });
});
