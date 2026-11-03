/**
 * Settings > Chat values the owner shares across devices. They live in the
 * server profile, not the device, so web and phone read one value. Only the
 * laptop-only column widths stay in local storage.
 *
 * A field absent from the profile means "never chosen", not "off": the clients
 * use the default, and the web app may import its pre-profile browser value
 * once. That is why nothing here writes a default to the server on read.
 */
export const SHARED_PREFERENCE_DEFAULTS = {
  showToolSteps: false,
  showRoutinesStrip: true,
} as const;

export type SharedPreference = keyof typeof SHARED_PREFERENCE_DEFAULTS;

export type SharedPreferenceValues = { readonly [K in SharedPreference]: boolean };

/** The profile fields, with an absent field meaning never chosen. */
export type StoredSharedPreferences = { readonly [K in SharedPreference]?: boolean };

interface LegacyPreferenceKey {
  readonly preference: SharedPreference;
  /** The localStorage key this preference used before it moved to the server. */
  readonly legacyKey: string;
}

export const SHARED_PREFERENCES: ReadonlyArray<LegacyPreferenceKey> = [
  { preference: "showToolSteps", legacyKey: "personal-show-tool-steps" },
  { preference: "showRoutinesStrip", legacyKey: "personal-show-routines-strip" },
];

export interface SharedPreferenceImportPlan {
  /** What the server is missing, ready for one `setProfile` call. */
  readonly values: StoredSharedPreferences;
  /** Browser keys the caller may remove once the server has the value. */
  readonly clearLegacyKeys: ReadonlyArray<string>;
}

/** Reads one browser value; null means the key is not there. */
export type LegacyPreferenceReader = (key: string) => string | null;

function readLegacy(reader: LegacyPreferenceReader, key: string): string | null {
  try {
    return reader(key);
  } catch {
    // Storage unavailable (private mode): there is nothing to import.
    return null;
  }
}

/** "1" and "0" are the only values the old store wrote; anything else is junk. */
function parseLegacy(raw: string): boolean | undefined {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return undefined;
}

/** The values a client shows: a stored choice wins, otherwise the default. */
export function sharedPreferencesFromProfile(
  profile: StoredSharedPreferences | null | undefined,
): SharedPreferenceValues {
  return {
    showToolSteps: profile?.showToolSteps ?? SHARED_PREFERENCE_DEFAULTS.showToolSteps,
    showRoutinesStrip: profile?.showRoutinesStrip ?? SHARED_PREFERENCE_DEFAULTS.showRoutinesStrip,
  };
}

/**
 * The one-time move of the browser values onto the server.
 *
 * A null profile means no profile could be read (an older server, or none
 * yet), so nothing is imported and nothing is cleared: the browser value stays
 * the only copy. With a profile, a server value always wins; a missing one is
 * taken from the browser. Repeating the call after the write changes nothing,
 * because the profile now carries the value.
 */
export function planSharedPreferenceImport(
  profile: StoredSharedPreferences | null,
  reader: LegacyPreferenceReader,
): SharedPreferenceImportPlan {
  if (profile === null) return { values: {}, clearLegacyKeys: [] };
  const values: Partial<Record<SharedPreference, boolean>> = {};
  const clearLegacyKeys: string[] = [];
  for (const { preference, legacyKey } of SHARED_PREFERENCES) {
    const raw = readLegacy(reader, legacyKey);
    const stored = profile[preference];
    if (stored !== undefined) {
      if (raw !== null) clearLegacyKeys.push(legacyKey);
      continue;
    }
    if (raw === null) continue;
    // The key is cleared even when its value is junk: there is nothing left
    // to import and leaving it would retry the same dead key forever.
    clearLegacyKeys.push(legacyKey);
    const value = parseLegacy(raw);
    if (value !== undefined) values[preference] = value;
  }
  return { values, clearLegacyKeys };
}
