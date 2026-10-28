/**
 * One wording match for provider limits, shared by every adapter that reads a
 * failure message instead of a structured status.
 *
 * A failed turn that names a limit (quota, free usage, 429, "at capacity")
 * must carry `retry: {kind:"rate_limited"}`, or the personal layer never moves
 * the bot to its fallback model: `PersonalChatResumeService` and the task
 * dispatcher both key off `session.providerRetry.kind`. The text is still the
 * provider's own; only the kind is normalized here.
 *
 * @module provider/providerLimitRetry
 */
import type { ProviderRetryInfo } from "@t3tools/contracts";

const LIMIT_PATTERN =
  /rate.?limit|too many requests|\b429\b|quota|usage limit|free usage|limit (?:exceeded|reached)|exceeded .{0,30}limit|at capacity|overloaded|try a different model/i;
const REASON_MAX_LENGTH = 200;

/** True when any of the provider's own texts says a limit stopped the turn. */
export function isProviderLimitText(...texts: ReadonlyArray<string | null | undefined>): boolean {
  return texts.some(
    (text) => typeof text === "string" && text.trim().length > 0 && LIMIT_PATTERN.test(text),
  );
}

/**
 * A failed turn that stopped on a provider limit. No `retryAt`: an adapter
 * that only got a message never invents a reset time.
 */
export function providerLimitRetryInfo(
  ...texts: ReadonlyArray<string | null | undefined>
): ProviderRetryInfo | undefined {
  if (!isProviderLimitText(...texts)) return undefined;
  const raw = texts.find(
    (text): text is string => typeof text === "string" && text.trim().length > 0,
  );
  const reason = (raw ?? "").replaceAll(/\s+/g, " ").trim();
  return {
    kind: "rate_limited",
    ...(reason.length > 0
      ? { reason: reason.length <= REASON_MAX_LENGTH ? reason : reason.slice(0, REASON_MAX_LENGTH) }
      : {}),
  };
}
