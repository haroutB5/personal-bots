import { describe, expect, it } from "vite-plus/test";

import { createFocusReplyGuard } from "./focusReplyGuard";

describe("focus reply guard", () => {
  it("acts on the reply to the newest input", () => {
    const guard = createFocusReplyGuard();
    const tap = guard.issue();
    expect(guard.accept(tap)).toBe(true);
  });

  // Tap a button, tap a text field before the button's "no field" answer is back.
  it("ignores a late reply to an earlier input once a newer one was sent", () => {
    const guard = createFocusReplyGuard();
    const button = guard.issue();
    const field = guard.issue();
    expect(guard.accept(button)).toBe(false);
    expect(guard.accept(field)).toBe(true);
  });

  it("ignores an older reply that arrives after a newer one was applied", () => {
    const guard = createFocusReplyGuard();
    const first = guard.issue();
    const second = guard.issue();
    expect(guard.accept(second)).toBe(true);
    expect(guard.accept(first)).toBe(false);
  });

  it("takes the delayed second look for the same input", () => {
    const guard = createFocusReplyGuard();
    const tap = guard.issue();
    expect(guard.accept(tap)).toBe(true);
    expect(guard.accept(tap)).toBe(true);
  });

  it("always acts on a reply without a number (an older server)", () => {
    const guard = createFocusReplyGuard();
    guard.issue();
    guard.issue();
    expect(guard.accept(undefined)).toBe(true);
  });
});
