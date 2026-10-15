/**
 * A start limit for voice calls: at most `limit` starts per `windowMs`, so a
 * looping client cannot burn the saved Gemini key's quota. In memory on
 * purpose: the counter is a guard against a loop, not a billed resource, and a
 * restart clearing it is fine.
 */
export interface VoiceCallRateLimiter {
  /** True when this start is allowed, and records it. */
  readonly take: (nowMs: number) => boolean;
}

export const createVoiceCallRateLimiter = (input: {
  readonly limit: number;
  readonly windowMs: number;
}): VoiceCallRateLimiter => {
  let hits: Array<number> = [];
  return {
    take: (nowMs) => {
      hits = hits.filter((at) => at > nowMs - input.windowMs);
      if (hits.length >= input.limit) return false;
      hits.push(nowMs);
      return true;
    },
  };
};
