import { describe, expect, it } from "vite-plus/test";

import { chatKeyboardLayout } from "./chatKeyboardLayout";

const measured = {
  bodyHeight: 683,
  composerHeight: 50,
  dockHeight: 36,
};

describe("chatKeyboardLayout", () => {
  it("puts the card bottom above the keyboard and the hidden dock", () => {
    const layout = chatKeyboardLayout({
      ...measured,
      keyboardInset: 299,
      keyboardOpen: true,
      listHeight: 296,
    });

    expect(layout.dockVisible).toBe(false);
    expect(layout.dockTop).toBeNull();
    expect(layout.listBottom).toBe(334);
    expect(layout.cardMaxHeight).toBe(264);
    expect(layout.cardBottom).toBe(322);
    expect(layout.cardBottom).toBeLessThanOrEqual(
      Math.min(layout.keyboardTop, layout.dockTop ?? Number.POSITIVE_INFINITY),
    );
  });

  it("keeps the card above the dock while the keyboard is closed", () => {
    const layout = chatKeyboardLayout({
      ...measured,
      keyboardInset: 0,
      keyboardOpen: false,
      listHeight: 597,
    });

    expect(layout.dockVisible).toBe(true);
    expect(layout.dockTop).toBe(597);
    expect(layout.cardMaxHeight).toBe(565);
    expect(layout.cardBottom).toBe(585);
    expect(layout.cardBottom).toBeLessThanOrEqual(
      Math.min(layout.keyboardTop, layout.dockTop ?? Number.POSITIVE_INFINITY),
    );
  });

  it("gives the same list bottom when the window resizes instead of the inset", () => {
    const layout = chatKeyboardLayout({
      bodyHeight: 486,
      composerHeight: 50,
      dockHeight: 36,
      keyboardInset: 0,
      keyboardOpen: true,
      listHeight: 436,
    });

    expect(layout.listBottom).toBe(436);
    expect(layout.keyboardTop).toBe(486);
    expect(layout.cardBottom).toBe(424);
    expect(layout.cardBottom).toBeLessThanOrEqual(layout.keyboardTop);
  });

  it("leaves a positive list viewport so older messages still scroll", () => {
    const layout = chatKeyboardLayout({
      ...measured,
      keyboardInset: 299,
      keyboardOpen: true,
      listHeight: 296,
    });
    const olderMessagesHeight = 900;
    const maxScrollOffset = olderMessagesHeight + layout.cardMaxHeight - 296;

    expect(layout.cardMaxHeight).toBe(264);
    expect(maxScrollOffset).toBe(868);
    expect(maxScrollOffset).toBeGreaterThan(0);
  });
});
