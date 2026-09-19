import { useCallback } from "react";

import { useTheme } from "~/hooks/useTheme";

/**
 * Appearance control for the personal Bots surface.
 *
 * There is deliberately no second theme mechanism here. The upstream T3 app
 * already resolves System/Light/Dark, persists it in `localStorage`, mirrors it
 * to the desktop shell, re-resolves on an OS change and on a cross-tab write,
 * and — the part that matters most on the phone — applies it from the pre-paint
 * script in `index.html` before the first frame. All of that lands as a `.dark`
 * class on <html>, which is what `personal.css` keys its dark tokens off.
 *
 * So this module is a thin adapter: it narrows the upstream preference (which
 * can also name a custom palette) down to the three modes the Bots settings
 * screen offers, and hands back the resolved appearance for the rare component
 * that has to branch in JS rather than in CSS.
 *
 * Consequence to know about: the choice is app-wide, not Bots-only. Picking
 * Dark in Bots settings also darkens the upstream T3 screens behind the
 * developer-view escape hatch. That is the intended reading of "reuse the
 * plumbing" — one appearance per device, which is also what the OS-level
 * System option means.
 */
export type PersonalThemeMode = "system" | "light" | "dark";

export type PersonalAppearance = "light" | "dark";

export const PERSONAL_THEME_MODES: readonly PersonalThemeMode[] = ["system", "light", "dark"];

export const PERSONAL_THEME_MODE_LABELS: Readonly<Record<PersonalThemeMode, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/** Default when nothing has ever been chosen: follow the phone. */
export const DEFAULT_PERSONAL_THEME_MODE: PersonalThemeMode = "system";

export function isPersonalThemeMode(value: unknown): value is PersonalThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * The whole of the theme decision, as a pure function.
 *
 * `systemDark` is the live `(prefers-color-scheme: dark)` match. An unknown or
 * missing mode falls back to System rather than to Light: a device with no
 * stored preference and a dark OS should open dark, not flash white.
 */
export function resolvePersonalAppearance(
  mode: PersonalThemeMode | null | undefined,
  systemDark: boolean,
): PersonalAppearance {
  const effective = isPersonalThemeMode(mode) ? mode : DEFAULT_PERSONAL_THEME_MODE;
  if (effective === "light") return "light";
  if (effective === "dark") return "dark";
  return systemDark ? "dark" : "light";
}

export interface PersonalThemeControl {
  /** What the Settings segmented control shows as selected. */
  readonly mode: PersonalThemeMode;
  /** What the surface is actually painted as right now. */
  readonly appearance: PersonalAppearance;
  /** Returns false when the preference could not be persisted. */
  readonly setMode: (mode: PersonalThemeMode) => boolean;
}

/**
 * Bots-facing view of the upstream theme store. `appearanceMode` is already
 * exactly System/Light/Dark upstream, so no mapping is needed in that
 * direction; the guard is only there because the stored value is user-editable
 * storage, not a typed channel.
 */
export function usePersonalTheme(): PersonalThemeControl {
  const { appearanceMode, resolvedTheme, setAppearanceMode } = useTheme();
  const setMode = useCallback(
    (mode: PersonalThemeMode) => setAppearanceMode(mode),
    [setAppearanceMode],
  );
  return {
    mode: isPersonalThemeMode(appearanceMode) ? appearanceMode : DEFAULT_PERSONAL_THEME_MODE,
    appearance: resolvedTheme === "dark" ? "dark" : "light",
    setMode,
  };
}
