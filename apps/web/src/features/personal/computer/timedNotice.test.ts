import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createTimedNotice, REJECTED_NOTICE_MS } from "./timedNotice";

/** A tiny stand-in for the screen's `useState`, so the test reads the notice that would be on screen. */
function makeNotice() {
  let current: string | null = null;
  const timed = createTimedNotice((update) => {
    current = update(current);
  });
  return { timed, read: () => current, set: (value: string | null) => (current = value) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("timed refusal notice", () => {
  it("shows the reason at once and removes it after a few seconds", () => {
    const { timed, read } = makeNotice();
    timed.show("The site refused the connection.");
    expect(read()).toBe("The site refused the connection.");
    vi.advanceTimersByTime(REJECTED_NOTICE_MS - 1);
    expect(read()).toBe("The site refused the connection.");
    vi.advanceTimersByTime(1);
    expect(read()).toBeNull();
  });

  it("a newer refusal restarts the clock instead of being cut short by the old one", () => {
    const { timed, read } = makeNotice();
    timed.show("first");
    vi.advanceTimersByTime(REJECTED_NOTICE_MS - 1_000);
    timed.show("second");
    vi.advanceTimersByTime(2_000);
    expect(read()).toBe("second");
    vi.advanceTimersByTime(REJECTED_NOTICE_MS);
    expect(read()).toBeNull();
  });

  it("does not remove a different notice that took its place (FramesHidden)", () => {
    const { timed, read, set } = makeNotice();
    timed.show("refused");
    set("The view is hidden.");
    vi.advanceTimersByTime(REJECTED_NOTICE_MS + 1);
    expect(read()).toBe("The view is hidden.");
  });

  it("cancel stops the pending removal", () => {
    const { timed, read } = makeNotice();
    timed.show("refused");
    timed.cancel();
    vi.advanceTimersByTime(REJECTED_NOTICE_MS * 2);
    expect(read()).toBe("refused");
  });
});
