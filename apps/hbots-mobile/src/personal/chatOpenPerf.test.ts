import { describe, expect, it } from "vite-plus/test";

import {
  noteCacheRead,
  noteCacheWrite,
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
});
