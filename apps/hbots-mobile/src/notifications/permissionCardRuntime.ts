import * as SecureStore from "expo-secure-store";

import { createPermissionCardStore } from "./permissionCardStore";

const KEY = "hbots.notify-card.v1";

/** The one memory of the in-chat notification ask for this app run. */
export const permissionCardStore = createPermissionCardStore({
  read: () => SecureStore.getItem(KEY),
  write: (value) => SecureStore.setItem(KEY, value),
});
