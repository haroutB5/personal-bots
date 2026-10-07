import { useMediaQuery } from "~/hooks/useMediaQuery";

import { PERSONAL_NUMBER_PREFERENCE_DEFAULTS, usePersonalPreference } from "./personalPreferences";

/**
 * Desktop (md+) column widths: the bot list on the left and, from 1440px, the
 * Computer + Routines panel beside a chat. Both are resizable; the chat in the
 * middle always keeps room for a ~560px reading column.
 *
 * The widths reach the page as CSS variables (`--personal-sidebar-width`,
 * `--personal-side-panel-width`) wrapped in a CSS `clamp()`, so a drag writes
 * one variable per pointer move and never re-renders the transcript, and a
 * window resize re-clamps without any script at all.
 */
export const SIDEBAR_WIDTH = {
  min: 280,
  max: 480,
  default: PERSONAL_NUMBER_PREFERENCE_DEFAULTS.sidebarWidth,
} as const;
export const SIDE_PANEL_WIDTH = {
  min: 320,
  max: 560,
  default: PERSONAL_NUMBER_PREFERENCE_DEFAULTS.sidePanelWidth,
} as const;
/** A 560px reading column plus the chat's 16px gutters. */
export const CHAT_MIN_WIDTH = 592;
/** Arrow-key step of a resize handle. */
export const RESIZE_STEP = 16;
/** Where the side panel fits beside a chat at all. */
export const SIDE_PANEL_MIN_VIEWPORT = 1440;

export const SIDEBAR_ID = "personal-bot-list";

export function clampWidth(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Widest the bot list may be at this viewport. With the side panel open the
 * panel's minimum is kept free too, so the list can never squeeze the chat
 * below its floor by pushing the panel into it.
 */
export function sidebarMaxWidth(viewport: number, sidePanelOpen: boolean): number {
  const reserve = CHAT_MIN_WIDTH + (sidePanelOpen ? SIDE_PANEL_WIDTH.min : 0);
  return clampWidth(viewport - reserve, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max);
}

/** Widest the side panel may be beside a bot list of `sidebarWidth`. */
export function sidePanelMaxWidth(viewport: number, sidebarWidth: number): number {
  return clampWidth(
    viewport - sidebarWidth - CHAT_MIN_WIDTH,
    SIDE_PANEL_WIDTH.min,
    SIDE_PANEL_WIDTH.max,
  );
}

/**
 * The bot list's width as CSS, the same rule as `sidebarMaxWidth`. Set on the
 * shell as `--personal-sidebar-effective`, so the panel can subtract it.
 */
export function sidebarWidthCss(sidePanelOpen: boolean): string {
  const { min, max } = SIDEBAR_WIDTH;
  const reserve = CHAT_MIN_WIDTH + (sidePanelOpen ? SIDE_PANEL_WIDTH.min : 0);
  return `clamp(${min}px, var(--personal-sidebar-width, ${SIDEBAR_WIDTH.default}px), max(${min}px, min(${max}px, 100vw - ${reserve}px)))`;
}

/** The side panel's width as CSS, the same rule as `sidePanelMaxWidth`. */
export function sidePanelWidthCss(): string {
  const { min, max } = SIDE_PANEL_WIDTH;
  return `clamp(${min}px, var(--personal-side-panel-width, ${SIDE_PANEL_WIDTH.default}px), max(${min}px, min(${max}px, 100vw - var(--personal-sidebar-effective, ${SIDEBAR_WIDTH.default}px) - ${CHAT_MIN_WIDTH}px)))`;
}

/** Whether the side panel fits, and whether it is open (fits and not hidden). */
export function useChatSidePanel(): { readonly fits: boolean; readonly open: boolean } {
  const fits = useMediaQuery({ min: SIDE_PANEL_MIN_VIEWPORT });
  const preferred = usePersonalPreference("showChatSidePanel");
  return { fits, open: fits && preferred };
}
