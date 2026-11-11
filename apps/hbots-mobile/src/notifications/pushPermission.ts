import { PermissionsAndroid, Platform } from "react-native";

import type { PermissionPort } from "./pushController";

const POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS" as const;

/** Android 13 (API 33) added the runtime permission. Older versions only have the settings switch. */
export const androidPermission: PermissionPort = {
  async request() {
    if (Platform.OS !== "android" || Number(Platform.Version) < 33) return "not-needed";
    try {
      const answer = await PermissionsAndroid.request(POST_NOTIFICATIONS);
      if (answer === PermissionsAndroid.RESULTS.GRANTED) return "granted";
      if (answer === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return "blocked";
      return "denied";
    } catch {
      return "denied";
    }
  },
};
