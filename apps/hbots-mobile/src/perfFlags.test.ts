import { afterEach, describe, expect, it } from "vite-plus/test";

import { androidPerfOptimizationOn, resetPerfOffForTest, setPerfOff } from "./perfFlags";

afterEach(resetPerfOffForTest);

describe("android perf switches", () => {
  it("are all on until a server lists one", () => {
    expect(androidPerfOptimizationOn("android-preload-chat")).toBe(true);
  });

  it("turns off exactly the names the server lists", () => {
    setPerfOff(["android-other", "android-preload-chat"]);
    expect(androidPerfOptimizationOn("android-preload-chat")).toBe(false);

    setPerfOff(["android-other"]);
    expect(androidPerfOptimizationOn("android-preload-chat")).toBe(true);
  });
});
