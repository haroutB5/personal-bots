/**
 * How fast the owner's own WhatsApp is allowed to send.
 *
 * Enforcement is server-side and pure, so the boundaries can be tested without
 * a browser. The numbers exist because the risk here is account-level: a
 * handful of human-paced messages a day to existing contacts looks like a
 * person, and bulk or burst traffic looks like the automation it is. Past a
 * limit the answer is a refusal, never a queue — a run that quietly spends
 * tomorrow's budget is how volume turns into a banned number.
 */

/**
 * A rolling 24 hours rather than a calendar day.
 *
 * A calendar day has a boundary to burst across and a timezone to argue
 * about; a rolling window has neither, and the refusal says "in the last 24
 * hours" so the owner reads the same rule the server applies.
 */
export const SEND_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Two messages a few seconds apart is the single most automated-looking pattern. */
export const MIN_SEND_GAP_MS = 60_000;

const TYPING_BASE_MS = 1_200;
const TYPING_PER_CHARACTER_MS = 45;
export const MAX_TYPING_DELAY_MS = 20_000;

export type PacingVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Roughly how long the message would have taken to type, bounded. */
export const typingDelayMs = (text: string): number =>
  Math.min(MAX_TYPING_DELAY_MS, TYPING_BASE_MS + text.length * TYPING_PER_CHARACTER_MS);

export function checkPacing(input: {
  readonly dailySendCap: number;
  /** Epoch milliseconds of previous sends on this connection, any order. */
  readonly sentAtMs: ReadonlyArray<number>;
  readonly nowMs: number;
}): PacingVerdict {
  const windowStart = input.nowMs - SEND_WINDOW_MS;
  const inWindow = input.sentAtMs.filter((at) => at > windowStart);
  // The cap is reported first when both apply: waiting out a gap is a minute,
  // and being over the cap is the answer the bot has to act on.
  if (inWindow.length >= input.dailySendCap) {
    return {
      allowed: false,
      reason: `The owner's WhatsApp send limit of ${input.dailySendCap} messages in 24 hours is used up (${inWindow.length} sent). Nothing was sent and nothing is waiting to be. Tell the owner; they can raise the limit in Settings > Connections.`,
    };
  }
  const last = inWindow.length === 0 ? null : Math.max(...inWindow);
  if (last !== null) {
    const waited = input.nowMs - last;
    if (waited < MIN_SEND_GAP_MS) {
      const remaining = Math.ceil((MIN_SEND_GAP_MS - waited) / 1_000);
      return {
        allowed: false,
        reason: `hbots leaves at least ${MIN_SEND_GAP_MS / 1_000} seconds between WhatsApp messages so the owner's account does not look automated. Try again in ${remaining} second${remaining === 1 ? "" : "s"}. Nothing was sent.`,
      };
    }
  }
  return { allowed: true };
}
