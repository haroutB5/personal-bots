import { describe, expect, it } from "vite-plus/test";

import { DeepSeekSettings } from "../settings.ts";
import { DeepSeekDriver } from "./driver.ts";

describe("DeepSeekDriver", () => {
  it("is the DeepSeek driver with the name users see", () => {
    expect(DeepSeekDriver.driverKind).toBe("deepseek");
    expect(DeepSeekDriver.metadata.displayName).toBe("DeepSeek");
    expect(DeepSeekDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("rebuilds for every config key except the peak switch", () => {
    expect(DeepSeekDriver.rebuildIrrelevantConfigKeys).toEqual(["peakSwitch"]);
  });

  it("decodes and validates DeepSeek settings", () => {
    expect(DeepSeekDriver.configSchema).toBe(DeepSeekSettings);
    expect(DeepSeekDriver.defaultConfig()).toEqual({
      enabled: false,
      engine: "dsh",
      peakSwitch: true,
      dshRuntimePath: "",
      binaryPath: "claude",
      homePath: "",
      customModels: [],
    });
  });
});
