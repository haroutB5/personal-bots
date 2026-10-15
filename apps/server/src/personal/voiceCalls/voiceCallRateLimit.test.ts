import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createVoiceCallRateLimiter } from "./voiceCallRateLimit.ts";

describe("createVoiceCallRateLimiter", () => {
  it.effect("allows the limit, refuses the one after it, and forgives once the window passes", () =>
    Effect.sync(() => {
      const limiter = createVoiceCallRateLimiter({ limit: 3, windowMs: 60_000 });
      expect([limiter.take(0), limiter.take(1), limiter.take(2)]).toEqual([true, true, true]);
      expect(limiter.take(3)).toBe(false);
      // Still inside the window one second later.
      expect(limiter.take(1_000)).toBe(false);
      // The first three have fallen out of the window.
      expect(limiter.take(60_001)).toBe(true);
      expect(limiter.take(60_002)).toBe(true);
      expect(limiter.take(60_003)).toBe(true);
      expect(limiter.take(60_004)).toBe(false);
    }),
  );
});
