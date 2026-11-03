import * as SecureStore from "expo-secure-store";

const SERVER_STORAGE_ID = "hbots.server.v1";

/** The last paired server address is not a secret. Keeping it lets a signed-out phone still see an update. */
export async function saveServer(httpBaseUrl: string): Promise<void> {
  await SecureStore.setItemAsync(SERVER_STORAGE_ID, httpBaseUrl);
}

export async function loadServer(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_STORAGE_ID);
}
