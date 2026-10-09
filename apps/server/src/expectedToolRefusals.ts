/**
 * Bot tools refuse things on purpose: the owner has taken the browser, a login
 * does not match the page, a site's certificate cannot be trusted. The MCP
 * toolkit runner logs every failed tool call at ERROR with its stack, so each
 * refusal looked like a server fault and tripped the "0 ERROR since restart"
 * release check. These failures are answers sent to the bot, not faults: they
 * are logged at INFO, one line, no stack. Anything else (a defect, a tool that
 * broke, an error type not named here) stays ERROR.
 */
import * as AiError from "effect/unstable/ai/AiError";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Logger from "effect/Logger";

/** Tool failures that are declared outcomes reported to the model. */
export const EXPECTED_TOOL_REFUSAL_TAGS: ReadonlySet<string> = new Set([
  "BotsToolError",
  "PersonalToolError",
  "DesktopToolError",
  "PreviewAutomationControlInterruptedError",
  "PreviewAutomationExecutionError",
  "PreviewAutomationTabNotFoundError",
  "PreviewAutomationInvalidSelectorError",
  "PreviewAutomationTargetNotEditableError",
  "PreviewAutomationResultTooLargeError",
]);

const errorTag = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const tag = (error as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : undefined;
};

const errorText = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const { message, reason } = error as { message?: unknown; reason?: unknown };
    if (typeof message === "string" && message.length > 0) return message;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return "";
};

/**
 * The refusals a cause is made of, or null when it holds anything else: a
 * defect, an interruption, or an error type that is not a declared refusal.
 */
export function expectedToolRefusals(
  cause: Cause.Cause<unknown>,
): ReadonlyArray<{ readonly tag: string; readonly message: string }> | null {
  if (cause.reasons.length === 0) return null;
  const refusals: Array<{ readonly tag: string; readonly message: string }> = [];
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) return null;
    if (
      Schema.is(AiError.AiError)(reason.error) &&
      reason.error.reason._tag === "ToolParameterValidationError" &&
      reason.error.reason.toolName === "save_memory"
    ) {
      refusals.push({ tag: "MemoryInputValidation", message: "save_memory input refused" });
      continue;
    }
    const tag = errorTag(reason.error);
    if (tag === undefined || !EXPECTED_TOOL_REFUSAL_TAGS.has(tag)) return null;
    refusals.push({ tag, message: errorText(reason.error) });
  }
  return refusals;
}

/** The same logger, except that an ERROR which only reports refusals is written as one INFO line. */
export const downgradeExpectedRefusals = <Output>(
  logger: Logger.Logger<unknown, Output>,
): Logger.Logger<unknown, Output> =>
  Logger.make((options) => {
    if (options.logLevel !== "Error") return logger.log(options);
    const refusals = expectedToolRefusals(options.cause);
    if (refusals === null) return logger.log(options);
    return logger.log({
      ...options,
      logLevel: refusals.some((item) => item.tag === "MemoryInputValidation") ? "Warn" : "Info",
      cause: Cause.empty,
      message: [
        `tool call refused: ${refusals
          .map((refusal) =>
            refusal.message === "" ? refusal.tag : `${refusal.tag}: ${refusal.message}`,
          )
          .join("; ")}`,
      ],
    });
  });
