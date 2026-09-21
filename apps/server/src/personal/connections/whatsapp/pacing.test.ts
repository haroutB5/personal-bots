import { describe, expect, it } from "@effect/vitest";

import {
  MIN_SEND_GAP_MS,
  SEND_WINDOW_MS,
  checkPacing,
  typingDelayMs,
  MAX_TYPING_DELAY_MS,
} from "./pacing.ts";

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

const check = (input: {
  readonly cap?: number;
  readonly sentAt?: ReadonlyArray<number>;
  readonly now?: number;
}) =>
  checkPacing({
    dailySendCap: input.cap ?? 3,
    sentAtMs: input.sentAt ?? [],
    nowMs: input.now ?? NOW,
  });

describe("whatsapp send pacing", () => {
  it("allows a send when nothing has gone out", () => {
    expect(check({}).allowed).toBe(true);
  });

  it("allows the send that reaches the cap and refuses the one after it", () => {
    const olderThanTheGap = NOW - MIN_SEND_GAP_MS - 1;
    const atTheCapBoundary = check({
      cap: 3,
      sentAt: [olderThanTheGap - 2, olderThanTheGap - 1],
    });
    expect(atTheCapBoundary.allowed).toBe(true);

    const overTheCap = check({
      cap: 3,
      sentAt: [olderThanTheGap - 3, olderThanTheGap - 2, olderThanTheGap - 1],
    });
    expect(overTheCap.allowed).toBe(false);
    if (overTheCap.allowed) return;
    // Refused, never queued: a run that silently spends tomorrow's budget is
    // how volume becomes a ban.
    expect(overTheCap.reason).toContain("3");
    expect(overTheCap.reason).not.toContain("queued");
  });

  it("counts only the sends inside the window, so the cap recovers", () => {
    const justOutside = NOW - SEND_WINDOW_MS - 1;
    const recovered = check({ cap: 1, sentAt: [justOutside] });
    expect(recovered.allowed).toBe(true);

    const justInside = NOW - SEND_WINDOW_MS + 1;
    const stillSpent = check({ cap: 1, sentAt: [justInside] });
    expect(stillSpent.allowed).toBe(false);
  });

  it("refuses inside the minimum gap and allows exactly on it", () => {
    const onTheGap = check({ cap: 10, sentAt: [NOW - MIN_SEND_GAP_MS] });
    expect(onTheGap.allowed).toBe(true);

    const insideTheGap = check({ cap: 10, sentAt: [NOW - MIN_SEND_GAP_MS + 1] });
    expect(insideTheGap.allowed).toBe(false);
    if (insideTheGap.allowed) return;
    expect(insideTheGap.reason).toContain("second");
  });

  it("reports the cap before the gap, because one is recoverable in a minute", () => {
    const both = check({ cap: 1, sentAt: [NOW - 1_000] });
    expect(both.allowed).toBe(false);
    if (both.allowed) return;
    expect(both.reason).toContain("24 hours");
  });

  it("types for longer when there is more to type, within a ceiling", () => {
    const short = typingDelayMs("ok");
    const long = typingDelayMs("x".repeat(500));
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThan(0);
    expect(typingDelayMs("x".repeat(100_000))).toBe(MAX_TYPING_DELAY_MS);
  });
});
