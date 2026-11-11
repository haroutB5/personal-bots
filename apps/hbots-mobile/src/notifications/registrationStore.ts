import * as SecureStore from "expo-secure-store";

import type { RegistrationStore, StoredRegistration } from "./pushController";

const KEY = "hbots.push-registration.v1";

/** Parses what was stored. Anything that is not exactly the saved shape counts as nothing saved. */
export function parseRegistration(raw: string | null): StoredRegistration | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { token, at, appVersion, delivery } = value as Record<string, unknown>;
    if (typeof token !== "string" || token.length === 0) return null;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    if (typeof appVersion !== "string") return null;
    if (delivery !== "ready" && delivery !== "disabled") return null;
    return { token, at, appVersion, delivery };
  } catch {
    return null;
  }
}

/** The last token the server accepted, kept in the Keystore-backed store so it dies with the session. */
export const secureRegistrationStore: RegistrationStore = {
  read: () => {
    try {
      return parseRegistration(SecureStore.getItem(KEY));
    } catch {
      return null;
    }
  },
  write: (value) => {
    try {
      SecureStore.setItem(KEY, JSON.stringify(value));
    } catch {
      // Without the store the next launch registers again, which is harmless.
    }
  },
  clear: () => {
    try {
      // Blank at once (the sync API has no delete), then remove the entry. A blank reads as nothing saved.
      SecureStore.setItem(KEY, "");
    } catch {
      // Same: a stale token is only a re-registration away from correct.
    }
    void SecureStore.deleteItemAsync(KEY).catch(() => undefined);
  },
};
