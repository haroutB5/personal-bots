/**
 * OpenCode provider waits, normalized onto the thread session so a throttled
 * bot reads "Rate limited" instead of "Working".
 *
 * OpenCode retries retryable provider errors itself (429, 5xx, "rate limit")
 * and reports each wait as `session.status {type:"retry", attempt, message,
 * next, action?}`, where `next` is the epoch-ms time of the next attempt.
 * `retryAt` is only set from that reported time; never estimated.
 *
 * @module provider/Layers/openCodeRetryInfo
 */
import type { ProviderRetryInfo } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface OpenCodeRetryStatus {
  readonly attempt: number;
  readonly message: string;
  readonly next: number;
  readonly action?: {
    readonly reason?: string;
    readonly title?: string;
    readonly message?: string;
  };
}

const RATE_LIMIT_PATTERN =
  /rate.?limit|too many requests|\b429\b|quota|usage limit|free usage|limit (?:exceeded|reached)|exceeded .{0,30}limit/i;
const REASON_MAX_LENGTH = 200;
/** Anything smaller is a delay or garbage, not an epoch-ms time (2001-09-09). */
const MIN_EPOCH_MS = 1_000_000_000_000;

function isoFromMillis(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < MIN_EPOCH_MS) return undefined;
  const dt = DateTime.make(ms);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

export function openCodeRetryInfo(status: OpenCodeRetryStatus): ProviderRetryInfo {
  const texts = [
    status.message,
    status.action?.reason,
    status.action?.title,
    status.action?.message,
  ].filter((text): text is string => typeof text === "string" && text.trim().length > 0);
  const rateLimited = texts.some((text) => RATE_LIMIT_PATTERN.test(text));
  const retryAt = isoFromMillis(status.next);
  const rawReason = (status.action?.message ?? status.message ?? "").replaceAll(/\s+/g, " ").trim();
  const reason =
    rawReason.length <= REASON_MAX_LENGTH ? rawReason : rawReason.slice(0, REASON_MAX_LENGTH);
  return {
    kind: rateLimited ? "rate_limited" : "retrying",
    ...(retryAt !== undefined ? { retryAt } : {}),
    ...(Number.isInteger(status.attempt) && status.attempt >= 0 ? { attempt: status.attempt } : {}),
    ...(reason.length > 0 ? { reason } : {}),
  };
}
