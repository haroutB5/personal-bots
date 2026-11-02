import * as SecureStore from "expo-secure-store";

import type { BotsCacheStorage } from "./botsCache";

const CACHE_KEY = "hbots.bots-cache.v1";

let writes: Promise<void> = Promise.resolve();

/** A sign-out clear queued after a write wins; the next launch reads what is on disk. */
function queue(write: () => Promise<void>): Promise<void> {
  writes = writes.then(write, write);
  return writes;
}

export const secureBotsCacheStorage: BotsCacheStorage = {
  read: () => SecureStore.getItemAsync(CACHE_KEY),
  write: (value) => queue(() => SecureStore.setItemAsync(CACHE_KEY, value)),
  remove: () => queue(() => SecureStore.deleteItemAsync(CACHE_KEY)),
};
