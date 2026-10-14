/**
 * Bot tools refuse things on purpose: the owner has taken the browser, a login
 * does not match the page, a site's certificate cannot be trusted. The MCP
 * toolkit runner logs every failed tool call at ERROR with its stack, so each
 * refusal looked like a server fault and tripped the "0 ERROR since restart"
 * release check. These failures are answers sent to the bot, not faults: they
 * are logged at INFO, one line, no stack. Anything else (a defect, a tool that
 * broke, an error type not named here) stays ERROR.
 *
 * A call the bot itself got wrong is the same kind of answer and is logged the
 * same way at WARN: parameters that do not fit the tool's schema, and a
 * credential that does not grant the capability the tool needs (the two shapes
 * behind 8 ERROR entries in three days). The line names the tool, the failing
 * path and the schema's own message, and never the arguments the bot sent,
 * which can hold private text.
 *
 * One refusal keeps a fixed wording: a save_memory schema failure, whose
 * description can echo the memory text the bot tried to save (1.66.15).
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

/**
 * The bot asked for something its credential does not allow. That is caller
 * input, not a server fault, so it is one WARN line (never a declared outcome
 * at INFO: the bot cannot fix it by rewording a tool call).
 */
const CALLER_INPUT_ERROR_TAGS: ReadonlySet<string> = new Set([
  "McpCapabilityUnavailableError",
  "PreviewAutomationUnavailableError",
]);

/** Longest schema message kept in the log line; the arguments themselves never go in. */
const MAX_REFUSAL_MESSAGE_CHARS = 300;

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
 * Effect writes a schema message as the reason, then the failing path on its
 * own `at [...]` line (several of them for a composite). The log line carries
 * both, on one line.
 */
const parameterValidationMessage = (description: string): string => {
  const text = description
    .replace(/\n\s+at\s+/g, " at ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_REFUSAL_MESSAGE_CHARS
    ? `${text.slice(0, MAX_REFUSAL_MESSAGE_CHARS - 1)}…`
    : text;
};

/**
 * The refusals a cause is made of, or null when it holds anything else: a
 * defect, an interruption, or an error type that is not a declared refusal.
 * A refusal's `tag` is its error tag, or the tool name for a schema failure.
 */
export function expectedToolRefusals(
  cause: Cause.Cause<unknown>,
): ReadonlyArray<{ readonly tag: string; readonly message: string }> | null {
  if (cause.reasons.length === 0) return null;
  const refusals: Array<{ readonly tag: string; readonly message: string }> = [];
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) return null;
    if (Schema.is(AiError.AiError)(reason.error)) {
      const failure = reason.error.reason;
      if (failure._tag !== "ToolParameterValidationError") return null;
      refusals.push(
        failure.toolName === "save_memory"
          ? { tag: "MemoryInputValidation", message: "save_memory input refused" }
          : { tag: failure.toolName, message: parameterValidationMessage(failure.description) },
      );
      continue;
    }
    const tag = errorTag(reason.error);
    if (tag !== undefined && CALLER_INPUT_ERROR_TAGS.has(tag)) {
      refusals.push({ tag, message: errorText(reason.error) });
      continue;
    }
    if (tag === undefined || !EXPECTED_TOOL_REFUSAL_TAGS.has(tag)) return null;
    refusals.push({ tag, message: errorText(reason.error) });
  }
  return refusals;
}

/** Declared outcomes are routine (INFO); anything else here is caller input (WARN). */
const refusalLevel = (tag: string): "Info" | "Warn" =>
  EXPECTED_TOOL_REFUSAL_TAGS.has(tag) ? "Info" : "Warn";

/** The same logger, except that an ERROR which only reports refusals is written as one line. */
export const downgradeExpectedRefusals = <Output>(
  logger: Logger.Logger<unknown, Output>,
): Logger.Logger<unknown, Output> =>
  Logger.make((options) => {
    if (options.logLevel !== "Error") return logger.log(options);
    const refusals = expectedToolRefusals(options.cause);
    if (refusals === null) return logger.log(options);
    return logger.log({
      ...options,
      logLevel: refusals.some((item) => refusalLevel(item.tag) === "Warn") ? "Warn" : "Info",
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
