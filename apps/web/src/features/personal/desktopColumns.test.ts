import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_MIN_WIDTH,
  clampWidth,
  SIDE_PANEL_WIDTH,
  SIDEBAR_WIDTH,
  sidebarMaxWidth,
  sidebarWidthCss,
  sidePanelMaxWidth,
  sidePanelWidthCss,
} from "./desktopColumns";

describe("desktop column limits", () => {
  it("never lets the bot list squeeze the chat below its reading column", () => {
    // 2000 wide, no panel: the list's own maximum is the limit.
    expect(sidebarMaxWidth(2000, false)).toBe(SIDEBAR_WIDTH.max);
    // 1000 wide: 1000 - 592 leaves 408 for the list.
    expect(sidebarMaxWidth(1000, false)).toBe(1000 - CHAT_MIN_WIDTH);
    // With the panel open its minimum is kept free as well: 1280 - 592 - 320.
    expect(sidebarMaxWidth(1280, true)).toBe(1280 - CHAT_MIN_WIDTH - SIDE_PANEL_WIDTH.min);
    expect(sidebarMaxWidth(1280, true)).toBe(368);
  });

  it("keeps the list at its minimum where nothing wider fits (a small md window)", () => {
    expect(sidebarMaxWidth(768, false)).toBe(SIDEBAR_WIDTH.min);
    expect(clampWidth(400, SIDEBAR_WIDTH.min, sidebarMaxWidth(768, false))).toBe(SIDEBAR_WIDTH.min);
  });

  it("sizes the panel against the list actually beside it", () => {
    expect(sidePanelMaxWidth(2560, 340)).toBe(SIDE_PANEL_WIDTH.max);
    expect(sidePanelMaxWidth(1440, 340)).toBe(1440 - 340 - CHAT_MIN_WIDTH);
    expect(sidePanelMaxWidth(1440, 480)).toBe(368);
    expect(sidePanelMaxWidth(1300, 480)).toBe(SIDE_PANEL_WIDTH.min);
  });

  it("clamps into range and prefers the minimum when the range is empty", () => {
    expect(clampWidth(100, 280, 480)).toBe(280);
    expect(clampWidth(900, 280, 480)).toBe(480);
    expect(clampWidth(350, 280, 480)).toBe(350);
    expect(clampWidth(350, 280, 200)).toBe(280);
  });

  it("writes the same rules as CSS, so a window resize re-clamps without script", () => {
    expect(sidebarWidthCss(false)).toBe(
      "clamp(280px, var(--personal-sidebar-width, 340px), max(280px, min(480px, 100vw - 592px)))",
    );
    expect(sidebarWidthCss(true)).toContain("100vw - 912px");
    expect(sidePanelWidthCss()).toBe(
      "clamp(320px, var(--personal-side-panel-width, 360px), max(320px, min(560px, 100vw - var(--personal-sidebar-effective, 340px) - 592px)))",
    );
  });
});
