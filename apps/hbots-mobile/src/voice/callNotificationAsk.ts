import * as SecureStore from "expo-secure-store";

import { nativeNotify } from "../notifications/nativeNotify";
import { androidPermission } from "../notifications/pushPermission";
import type { NotificationAsk } from "./callSession";

const ASKED_KEY = "hbots.voice.notifications-asked.v1";

function readAsked(): boolean {
  try {
    return SecureStore.getItem(ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeAsked(): void {
  try {
    SecureStore.setItem(ASKED_KEY, "1");
  } catch {
    return;
  }
}

export const callNotificationAsk: NotificationAsk = {
  enabled: () => nativeNotify?.notificationsEnabled() ?? true,
  alreadyAsked: readAsked,
  async ask() {
    writeAsked();
    await androidPermission.request();
  },
};
