import { describe, expect, it } from "vite-plus/test";

import { androidPerfOff } from "./perfFlags.ts";

describe("androidPerfOff", () => {
  it("is empty when PB_PERF_OFF is unset or blank", () => {
    expect(androidPerfOff({})).toEqual([]);
    expect(androidPerfOff({ PB_PERF_OFF: "" })).toEqual([]);
    expect(androidPerfOff({ PB_PERF_OFF: " , ," })).toEqual([]);
  });

  it("keeps only android- names, trimmed, in the order written", () => {
    expect(
      androidPerfOff({
        PB_PERF_OFF: "session-prewarm, android-preload-chat ,task-summaries,android-b",
      }),
    ).toEqual(["android-preload-chat", "android-b"]);
  });

  it("lists a name once", () => {
    expect(androidPerfOff({ PB_PERF_OFF: "android-preload-chat,android-preload-chat" })).toEqual([
      "android-preload-chat",
    ]);
  });

  it("does not take a server switch that merely contains the prefix", () => {
    expect(androidPerfOff({ PB_PERF_OFF: "not-android-x,androidish" })).toEqual([]);
  });

  it("reads tab and newline padding the same as spaces, and a whitespace-only value as nothing", () => {
    expect(androidPerfOff({ PB_PERF_OFF: "\tandroid-a\n, android-a ,android-b" })).toEqual([
      "android-a",
      "android-b",
    ]);
    expect(androidPerfOff({ PB_PERF_OFF: "\t\n" })).toEqual([]);
  });

  it("is case sensitive and does not take a look-alike hyphen, so a typo switches nothing off", () => {
    expect(androidPerfOff({ PB_PERF_OFF: "Android-preload-chat" })).toEqual([]);
    expect(androidPerfOff({ PB_PERF_OFF: "android\u2011preload-chat" })).toEqual([]);
  });

  it("passes a very long list through whole, because the value is the operator's", () => {
    const names = Array.from({ length: 50_000 }, (_, index) => `android-${index}`);

    expect(androidPerfOff({ PB_PERF_OFF: names.join(",") })).toHaveLength(50_000);
  });
});
