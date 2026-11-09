import { secretSettingsFields } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { DeepSeekSettings } from "./settings.ts";

const decode = Schema.decodeUnknownSync(DeepSeekSettings);

describe("DeepSeekSettings", () => {
  it("decodes an empty config to the DeepSeek defaults", () => {
    expect(decode({})).toEqual({
      enabled: false,
      engine: "dsh",
      peakSwitch: true,
      dshRuntimePath: "",
      binaryPath: "claude",
      homePath: "",
      customModels: [],
    });
  });

  it("keeps the API key out of the settings", () => {
    expect(secretSettingsFields(DeepSeekSettings)).toEqual([]);
  });
});
