import type { TraceRecord, TraceSink } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";

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

/**
 * The trace sink (`server.trace.ndjson`, and the browser's forwarded spans)
 * with every saved secret value masked in each record before it is queued: span
 * attributes, events, names and an exit's failure text all end up in that file.
 */
export const redactSecretsInTraceSink = (
  sink: TraceSink,
  redactor: SecretRedactor = secretRedactor,
): TraceSink => ({
  ...sink,
  push: (record: TraceRecord) => sink.push(redactor.active() ? redactor.redact(record) : record),
});

const maskExit = (
  exit: Exit.Exit<unknown, unknown>,
  redactor: SecretRedactor,
): Exit.Exit<unknown, unknown> => {
  if (!Exit.isFailure(exit)) return exit;
  const text = Cause.pretty(exit.cause);
  const masked = redactor.redactText(text);
  return masked === text ? exit : Exit.die(new Error(masked));
};

/**
 * A tracer whose spans mask saved secret values in what they are handed:
 * attributes, event attributes and an ending failure. Wraps the exporting
 * (OTLP) tracer, which sends those straight to a collector.
 */
export const redactSecretsInTracer = (
  tracer: Tracer.Tracer,
  redactor: SecretRedactor = secretRedactor,
): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const inner = tracer.span(options);
      return new Proxy(inner, {
        get(target, property) {
          if (property === "attribute") {
            return (key: string, value: unknown) =>
              target.attribute(key, redactor.active() ? redactor.redact(value) : value);
          }
          if (property === "event") {
            return (name: string, startTime: bigint, attributes?: Record<string, unknown>) =>
              target.event(
                name,
                startTime,
                attributes !== undefined && redactor.active()
                  ? redactor.redact(attributes)
                  : attributes,
              );
          }
          if (property === "end") {
            return (endTime: bigint, exit: Exit.Exit<unknown, unknown>) =>
              target.end(endTime, redactor.active() ? maskExit(exit, redactor) : exit);
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    ...(tracer.context ? { context: tracer.context } : {}),
  });
