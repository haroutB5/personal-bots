import type { EnvironmentId } from "@t3tools/contracts";
import {
  SHARED_PREFERENCE_DEFAULTS,
  planSharedPreferenceImport,
  sharedPreferencesFromProfile,
  type SharedPreference,
  type StoredSharedPreferences,
} from "@hbots/personal-client/settings/profilePreferences";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { useAtomCommand } from "~/state/use-atom-command";

import {
  personalProfileSet,
  usePersonalEnvironmentId,
  usePersonalProfile,
} from "./usePersonalBots";

/**
 * The device-local view preferences. The two Chat rows the owner shares
 * across web and phone live in the server profile instead, below; only the
 * desktop side panel, whose meaning depends on this screen's width, stays
 * here.
 */
const PREFERENCE_KEYS = {
  /**
   * The Computer + Routines panel pinned beside a chat on a wide desktop
   * (1440px+). On by default; the chat header toggles it.
   */
  showChatSidePanel: "personal-show-chat-side-panel",
} as const;

export type PersonalPreference = keyof typeof PREFERENCE_KEYS;

export const PERSONAL_PREFERENCE_DEFAULTS: Record<PersonalPreference, boolean> = {
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

/** Live value: an in-chat toggle updates every reader. */
export function usePersonalPreference(preference: PersonalPreference): boolean {
  const snapshot = useCallback(() => readPersonalPreference(preference), [preference]);
  const serverSnapshot = useCallback(() => PERSONAL_PREFERENCE_DEFAULTS[preference], [preference]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/**
 * Numeric view preferences: the desktop column widths the owner dragged to,
 * in CSS pixels. Same storage and the same subscribers as the flags above.
 * Only a finite positive number is ever read back; anything else (a hand-edited
 * key, a value from an older build) is the default. Clamping to what fits is
 * the layout's job, not the store's.
 */
const NUMBER_PREFERENCE_KEYS = {
  /** Width of the bot list beside the pane (md+). */
  sidebarWidth: "personal-desktop-sidebar-width",
  /** Width of the Computer + Routines panel beside a chat (1440px+). */
  sidePanelWidth: "personal-desktop-side-panel-width",
} as const;

export type PersonalNumberPreference = keyof typeof NUMBER_PREFERENCE_KEYS;

export const PERSONAL_NUMBER_PREFERENCE_DEFAULTS: Record<PersonalNumberPreference, number> = {
  sidebarWidth: 340,
  sidePanelWidth: 360,
};

export function readPersonalNumberPreference(preference: PersonalNumberPreference): number {
  try {
    const raw = window.localStorage.getItem(NUMBER_PREFERENCE_KEYS[preference]);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0
      ? value
      : PERSONAL_NUMBER_PREFERENCE_DEFAULTS[preference];
  } catch {
    return PERSONAL_NUMBER_PREFERENCE_DEFAULTS[preference];
  }
}

export function setPersonalNumberPreference(
  preference: PersonalNumberPreference,
  value: number,
): void {
  try {
    window.localStorage.setItem(NUMBER_PREFERENCE_KEYS[preference], String(Math.round(value)));
  } catch {
    // Storage unavailable: the drag still applied to the page for this visit.
  }
  for (const listener of listeners) listener();
}

export function usePersonalNumberPreference(preference: PersonalNumberPreference): number {
  const snapshot = useCallback(() => readPersonalNumberPreference(preference), [preference]);
  const serverSnapshot = useCallback(
    () => PERSONAL_NUMBER_PREFERENCE_DEFAULTS[preference],
    [preference],
  );
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

export type PersonalSharedPreference = SharedPreference;
export const PERSONAL_SHARED_PREFERENCE_DEFAULTS = SHARED_PREFERENCE_DEFAULTS;

/** One shared toggle as a profile input, typed instead of a computed key. */
export function sharedPreferenceInput(
  preference: SharedPreference,
  enabled: boolean,
): StoredSharedPreferences {
  return preference === "showToolSteps"
    ? { showToolSteps: enabled }
    : { showRoutinesStrip: enabled };
}

/**
 * A Chat row the whole account shares: the server value when it has one, the
 * default otherwise. A phone and every browser read through the same profile,
 * so a change on one shows on the next load of the other.
 */
export function usePersonalSharedPreference(preference: SharedPreference): boolean {
  const environmentId = usePersonalEnvironmentId();
  const profile = usePersonalProfile(environmentId);
  return sharedPreferencesFromProfile(profile.data)[preference];
}

/**
 * Saves one shared toggle. Resolves true once the server has the new value;
 * the profile refresh then redraws every reader. The ConversationScreen's
 * dismiss actions do not await it.
 */
export function useSetPersonalSharedPreference(): (
  preference: SharedPreference,
  enabled: boolean,
) => Promise<boolean> {
  const environmentId = usePersonalEnvironmentId();
  const setProfile = useAtomCommand(personalProfileSet);
  return useCallback(
    async (preference: SharedPreference, enabled: boolean) => {
      if (environmentId === null) return false;
      const result = await setProfile({
        environmentId,
        input: sharedPreferenceInput(preference, enabled),
      });
      return result._tag === "Success";
    },
    [environmentId, setProfile],
  );
}

function readBrowserPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function clearBrowserPreference(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable: there was nothing to import and nothing to clear.
  }
}

/**
 * Moves the pre-profile browser values onto the server, once per environment.
 *
 * It runs when a profile first arrives and never overwrites a value the server
 * already has. A browser value is removed only after the server confirms it
 * kept the new value, so an older server (which ignores the fields) leaves the
 * only copy in place and the next load retries.
 */
export function useImportPersonalSharedPreferences(environmentId: EnvironmentId | null): void {
  const profile = usePersonalProfile(environmentId);
  const setProfile = useAtomCommand(personalProfileSet, { reportFailure: false });
  const attempted = useRef(new Set<EnvironmentId>());

  useEffect(() => {
    if (environmentId === null || profile.data === null) return;
    if (attempted.current.has(environmentId)) return;
    const plan = planSharedPreferenceImport(profile.data, readBrowserPreference);
    const importing = Object.keys(plan.values).length > 0;
    if (!importing && plan.clearLegacyKeys.length === 0) return;
    attempted.current.add(environmentId);
    void (async () => {
      if (importing) {
        const result = await setProfile({ environmentId, input: plan.values });
        if (result._tag !== "Success") return;
        const kept = Object.entries(plan.values).every(
          ([preference, value]) => result.value[preference as SharedPreference] === value,
        );
        if (!kept) return;
      }
      for (const key of plan.clearLegacyKeys) clearBrowserPreference(key);
    })();
  }, [environmentId, profile.data, setProfile]);
}
