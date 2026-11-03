import * as SecureStore from "expo-secure-store";

export interface StoredSession {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly accessToken: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly pairedAt: number;
}

const SESSION_STORAGE_ID = "hbots.session.v1";

export async function saveSession(session: StoredSession): Promise<void> {
  await SecureStore.setItemAsync(SESSION_STORAGE_ID, JSON.stringify(session));
}

export async function loadSession(): Promise<StoredSession | null> {
  const stored = await SecureStore.getItemAsync(SESSION_STORAGE_ID);
  if (stored === null) {
    return null;
  }
  try {
    return JSON.parse(stored) as StoredSession;
  } catch {
    await clearSession();
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_STORAGE_ID);
}
