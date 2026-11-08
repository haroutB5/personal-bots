import { describe, expect, it } from "vite-plus/test";

import { DEEPSEEK_ENGINE_ENV, resolveDeepSeekEngine } from "./engine.ts";

describe("resolveDeepSeekEngine", () => {
  it("forces claude-code when the kill switch is off", () => {
    expect(resolveDeepSeekEngine({ engine: "dsh" }, { [DEEPSEEK_ENGINE_ENV]: "off" })).toBe(
      "claude-code",
    );
  });

  it("keeps the instance engine when the kill switch is unset", () => {
    expect(resolveDeepSeekEngine({ engine: "dsh" }, {})).toBe("dsh");
    expect(resolveDeepSeekEngine({ engine: "claude-code" }, {})).toBe("claude-code");
  });

  it("ignores a value that is not a kill-switch spelling", () => {
    expect(resolveDeepSeekEngine({ engine: "dsh" }, { [DEEPSEEK_ENGINE_ENV]: "on" })).toBe("dsh");
  });
});
