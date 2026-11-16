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
});
