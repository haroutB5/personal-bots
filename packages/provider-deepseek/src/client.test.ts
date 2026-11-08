import { describe, expect, it } from "vite-plus/test";

import { deepSeekClient } from "./client.ts";

describe("deepSeekClient", () => {
  it("is the DeepSeek driver and labels the provider DeepSeek", () => {
    expect(deepSeekClient.driverKind).toBe("deepseek");
    expect(deepSeekClient.label).toBe("DeepSeek");
  });

  it("offers the API key as a sensitive environment field, not a settings field", () => {
    expect(deepSeekClient.environmentFields?.[0]).toEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      label: "DeepSeek API key",
      description: "Keys come from platform.deepseek.com. Stored as this instance's environment.",
      placeholder: "sk-…",
      sensitive: true,
    });
  });
});
