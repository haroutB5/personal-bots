/**
 * Claude provider waits, normalized onto the thread session so clients and the
 * task dispatcher can tell "Working" from "rate limited until 09:47".
 *
 * - `system/api_retry` is the SDK's own retry loop. On a 429 it can wait for
 *   hours (observed: `retry_delay_ms` 21,600,000 with `max_retries` 300), and
 *   re-sends the heartbeat every ~30 s with a shrinking delay, so
 *   `observedAt + retry_delay_ms` stays put.
 * - A rejected `rate_limit_event` parks the turn until the window's
 *   `resetsAt` (epoch seconds).
 *
 * `retryAt` is only set from a reported delay or reset; never estimated.
 *
 * @module provider/Layers/claudeRetryInfo
 */
import type { SDKAPIRetryMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRetryInfo } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

function isoFromMillis(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const dt = DateTime.make(ms);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function errorName(error: unknown): string | undefined {
  if (typeof error === "string") return error.trim() === "" ? undefined : error.trim();
  if (typeof error === "object" && error !== null && "type" in error) {
    const type = (error as { readonly type: unknown }).type;
    return typeof type === "string" && type.trim() !== "" ? type.trim() : undefined;
  }
  return undefined;
}

export function claudeApiRetryInfo(
  message: Pick<SDKAPIRetryMessage, "attempt" | "max_retries" | "retry_delay_ms"> & {
    readonly error_status?: number | null;
    readonly error?: unknown;
  },
  observedAt: string,
): ProviderRetryInfo {
  const name = errorName(message.error);
  const rateLimited =
    message.error_status === 429 || (name !== undefined && /rate.?limit/i.test(name));
  const observedMs = Date.parse(observedAt);
  const delay = message.retry_delay_ms;
  const retryAt =
    Number.isFinite(observedMs) && typeof delay === "number" && Number.isFinite(delay) && delay >= 0
      ? isoFromMillis(observedMs + delay)
      : undefined;
  const reason = [
    typeof message.error_status === "number" ? `HTTP ${message.error_status}` : undefined,
    name,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  return {
    kind: rateLimited ? "rate_limited" : "retrying",
    ...(retryAt !== undefined ? { retryAt } : {}),
    ...(isNonNegativeInt(message.attempt) ? { attempt: message.attempt } : {}),
    ...(isNonNegativeInt(message.max_retries) ? { maxAttempts: message.max_retries } : {}),
    ...(reason !== "" ? { reason } : {}),
  };
}

export function claudeRateLimitRejectionInfo(info: SDKRateLimitInfo): ProviderRetryInfo {
  const resetsAt =
    typeof info.resetsAt === "number" && info.resetsAt > 0
      ? isoFromMillis(info.resetsAt * 1000)
      : undefined;
  return {
    kind: "rate_limited",
    ...(resetsAt !== undefined ? { retryAt: resetsAt } : {}),
    ...(info.rateLimitType ? { reason: info.rateLimitType } : {}),
  };
}
