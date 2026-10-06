import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_SDK_CAN_USE_TOOL_SHADOWED,
  installClaudeSdkWarningFilter,
  isBypassCanUseToolShadowedWarning,
} from "./claudeSdkWarnings.ts";

const BYPASS =
  "canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback is consulted. To gate every tool call, use a PreToolUse hook instead.";
const ALLOWED_TOOLS =
  "canUseTool will not be invoked for: Read, Bash. Bare allowedTools entries auto-approve the whole tool before the callback is consulted.";

function fakeHost() {
  const seen: Array<unknown[]> = [];
  const host = {
    emitWarning: ((...args: unknown[]) => {
      seen.push(args);
    }) as unknown as typeof process.emitWarning,
  };
  return { host, seen };
}

describe("claudeSdkWarnings", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });

  it("recognises only the bypassPermissions wording of the shadowed warning", () => {
    const code = { code: CLAUDE_SDK_CAN_USE_TOOL_SHADOWED };
    expect(isBypassCanUseToolShadowedWarning(BYPASS, [code])).toBe(true);
    expect(
      isBypassCanUseToolShadowedWarning(BYPASS, ["Warning", CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]),
    ).toBe(true);
    expect(isBypassCanUseToolShadowedWarning(ALLOWED_TOOLS, [code])).toBe(false);
    expect(isBypassCanUseToolShadowedWarning(BYPASS, [{ code: "SOMETHING_ELSE" }])).toBe(false);
    expect(isBypassCanUseToolShadowedWarning(BYPASS, [])).toBe(false);
  });

  it("drops the bypass warning and passes every other warning through unchanged", () => {
    const { host, seen } = fakeHost();
    restores.push(installClaudeSdkWarningFilter(host));

    host.emitWarning(BYPASS, { code: CLAUDE_SDK_CAN_USE_TOOL_SHADOWED });
    host.emitWarning(ALLOWED_TOOLS, { code: CLAUDE_SDK_CAN_USE_TOOL_SHADOWED });
    host.emitWarning("other", { code: "OTHER" });
    host.emitWarning(new Error("plain"));

    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual([ALLOWED_TOOLS, { code: CLAUDE_SDK_CAN_USE_TOOL_SHADOWED }]);
    expect(seen[1]).toEqual(["other", { code: "OTHER" }]);
    expect(seen[2]?.[0]).toBeInstanceOf(Error);
  });

  it("installs once, and restores the original", () => {
    const { host, seen } = fakeHost();
    const original = host.emitWarning;
    const restore = installClaudeSdkWarningFilter(host);
    const wrapped = host.emitWarning;
    const again = installClaudeSdkWarningFilter(host);
    expect(host.emitWarning).toBe(wrapped);
    again();
    expect(host.emitWarning).toBe(wrapped);
    restore();
    expect(host.emitWarning).toBe(original);
    host.emitWarning(BYPASS, { code: CLAUDE_SDK_CAN_USE_TOOL_SHADOWED });
    expect(seen).toHaveLength(1);
  });

  it("really suppresses the node warning on the process", async () => {
    const warnings: Array<NodeJS.ErrnoException> = [];
    const onWarning = (warning: NodeJS.ErrnoException) => warnings.push(warning);
    process.on("warning", onWarning);
    restores.push(() => process.off("warning", onWarning));
    restores.push(installClaudeSdkWarningFilter());

    process.emitWarning(BYPASS, { code: CLAUDE_SDK_CAN_USE_TOOL_SHADOWED });
    process.emitWarning(ALLOWED_TOOLS, { code: CLAUDE_SDK_CAN_USE_TOOL_SHADOWED });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(warnings.map((w) => w.message)).toEqual([ALLOWED_TOOLS]);
  });
});
