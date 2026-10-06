import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";

import { secretRedactor, type SecretRedactor } from "./secretRedaction.ts";

/** An error whose message or stack carries a saved key becomes a copy with it masked. */
const maskError = (error: Error, redactor: SecretRedactor): Error => {
  const message = redactor.redactText(error.message);
  const stack = error.stack === undefined ? undefined : redactor.redactText(error.stack);
  if (message === error.message && stack === error.stack) return error;
  const copy = new Error(message);
  copy.name = error.name;
  if (stack !== undefined) copy.stack = stack;
  return copy;
};

const maskPart = (part: unknown, redactor: SecretRedactor): unknown =>
  part instanceof Error ? maskError(part, redactor) : redactor.redact(part);

/**
 * The same logger, with every saved secret value masked in what it is asked to
 * write: the message parts and a failure's text. A server log is read by people
 * and bots with file access, so a key a tool failed with must not land in it.
 * Costs nothing while no key is saved or the kill switch is set.
 */
export const redactSecretsInLogs = <Output>(
  logger: Logger.Logger<unknown, Output>,
  redactor: SecretRedactor = secretRedactor,
): Logger.Logger<unknown, Output> =>
  Logger.make((options) => {
    if (!redactor.active()) return logger.log(options);
    const message = Array.isArray(options.message)
      ? options.message.map((part: unknown) => maskPart(part, redactor))
      : maskPart(options.message, redactor);
    let cause = options.cause;
    if (cause.reasons.length > 0) {
      const text = Cause.pretty(cause);
      const masked = redactor.redactText(text);
      if (masked !== text) cause = Cause.die(new Error(masked));
    }
    return logger.log({ ...options, message, cause });
  });
