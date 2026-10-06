/**
 * The Claude Agent SDK prints a node warning on every session start that has a
 * `canUseTool` callback and `permissionMode: "bypassPermissions"`:
 *
 *   (node) CLAUDE_SDK_CAN_USE_TOOL_SHADOWED: canUseTool will not be invoked:
 *   permissionMode 'bypassPermissions' auto-approves every tool call ...
 *
 * The warning is generic and does not apply here: bypass mode auto-approves
 * tool calls, but `AskUserQuestion` and `ExitPlanMode` still go through
 * `canUseTool` (the adapter surfaces them as user-input and plan events), so
 * the callback must stay. Dropping it would change behaviour; this filter only
 * stops the one known-harmless warning from filling server.log.
 *
 * Only the bypass wording is dropped. The same code is also used for bare
 * `allowedTools` entries shadowing the callback, which would be a real
 * misconfiguration and stays visible.
 *
 * @module provider/Layers/claudeSdkWarnings
 */

export const CLAUDE_SDK_CAN_USE_TOOL_SHADOWED = "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED";

const BYPASS_WORDING = "permissionMode 'bypassPermissions'";

type EmitWarning = typeof process.emitWarning;
type WarningHost = { emitWarning: EmitWarning };

const INSTALLED = Symbol.for("t3code.claudeSdkWarningFilter");

function warningCode(rest: ReadonlyArray<unknown>): string | undefined {
  const [first, second] = rest;
  if (typeof first === "object" && first !== null) {
    const code = (first as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return typeof second === "string" ? second : undefined;
}

/** True for exactly the harmless bypassPermissions variant of the warning. */
export function isBypassCanUseToolShadowedWarning(
  warning: unknown,
  rest: ReadonlyArray<unknown>,
): boolean {
  if (warningCode(rest) !== CLAUDE_SDK_CAN_USE_TOOL_SHADOWED) return false;
  const message = typeof warning === "string" ? warning : (warning as Error | undefined)?.message;
  return typeof message === "string" && message.includes(BYPASS_WORDING);
}

/**
 * Wraps `emitWarning` on `host` (the process by default) once. Returns a
 * function that restores the original, for tests.
 */
export function installClaudeSdkWarningFilter(host: WarningHost = process): () => void {
  const current = host.emitWarning as EmitWarning & { [INSTALLED]?: EmitWarning };
  if (current[INSTALLED]) return () => undefined;
  const original = current;
  const filtered = function (this: unknown, warning: unknown, ...rest: Array<unknown>) {
    if (isBypassCanUseToolShadowedWarning(warning, rest)) return;
    return (original as (...args: Array<unknown>) => void).call(host, warning, ...rest);
  } as unknown as EmitWarning & { [INSTALLED]?: EmitWarning };
  filtered[INSTALLED] = original;
  host.emitWarning = filtered;
  return () => {
    if (host.emitWarning === filtered) host.emitWarning = original;
  };
}
