import { describe, expect, it } from "vite-plus/test";

describe("ClaudeAdapterV2 warning filter", () => {
  it("installs the bypassPermissions warning filter when the adapter loads", async () => {
    await import("./ClaudeAdapterV2.ts");
    const original = (process.emitWarning as unknown as Record<symbol, unknown>)[
      Symbol.for("t3code.claudeSdkWarningFilter")
    ];
    expect(original).toBeTypeOf("function");
    expect(original).not.toBe(process.emitWarning);
  });
});
