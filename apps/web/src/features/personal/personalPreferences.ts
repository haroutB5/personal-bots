import { useCallback, useSyncExternalStore } from "react";

/**
 * Device-local view preferences for the bots app, stored the same way the
 * Diagnostics flag is (`window.localStorage`, one key per flag, absent storage
 * simply means the default). Unlike that flag these are read while a chat is
 * mounted, so writes notify subscribers and every reader re-renders at once.
 */
const PREFERENCE_KEYS = {
  /** Collapsed tool/work group rows in a chat ("> 2 steps"). Off by default. */
  showToolSteps: "personal-show-tool-steps",
  /** The "Routines / See all" strip under a chat. On by default. */
  showRoutinesStrip: "personal-show-routines-strip",
  /**
   * The Computer + Routines panel pinned beside a chat on a wide desktop
   * (1440px+). On by default; the chat header toggles it.
   */
  showChatSidePanel: "personal-show-chat-side-panel",
} as const;

export type PersonalPreference = keyof typeof PREFERENCE_KEYS;

export const PERSONAL_PREFERENCE_DEFAULTS: Record<PersonalPreference, boolean> = {
  showToolSteps: false,
  showRoutinesStrip: true,
  showChatSidePanel: true,
};

const listeners = new Set<() => void>();

export function readPersonalPreference(preference: PersonalPreference): boolean {
  try {
    const raw = window.localStorage.getItem(PREFERENCE_KEYS[preference]);
    if (raw === null) return PERSONAL_PREFERENCE_DEFAULTS[preference];
    return raw === "1";
  } catch {
    // Storage unavailable (private mode, stubbed test globals): use the default.
    return PERSONAL_PREFERENCE_DEFAULTS[preference];
  }
}

export function setPersonalPreference(preference: PersonalPreference, enabled: boolean): void {
  try {
    // The value is always written, never removed: "off" for a default-on flag
    // has to survive a reload, and absent already means "default".
    window.localStorage.setItem(PREFERENCE_KEYS[preference], enabled ? "1" : "0");
  } catch {
    // Storage unavailable: the change still applies for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Live value: a Settings toggle or an in-chat dismiss updates every reader. */
export function usePersonalPreference(preference: PersonalPreference): boolean {
  const snapshot = useCallback(() => readPersonalPreference(preference), [preference]);
  const serverSnapshot = useCallback(() => PERSONAL_PREFERENCE_DEFAULTS[preference], [preference]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
