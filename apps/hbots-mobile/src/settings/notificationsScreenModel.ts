import type { PersonalPushPreferences } from "@t3tools/contracts";

import { NOTIFICATION_EVENTS } from "./settingsScreenModel";

export { notificationDeviceDetail, notificationDevicesLine } from "./settingsScreenModel";

export interface NotificationEventRow {
  readonly key: keyof PersonalPushPreferences;
  readonly label: string;
  readonly value: boolean;
}

/** The five event switches, all on until the server says otherwise. */
export function notificationEventRows(
  preferences: PersonalPushPreferences | null,
): ReadonlyArray<NotificationEventRow> {
  return NOTIFICATION_EVENTS.map((event) => ({
    key: event.key,
    label: event.label,
    value: preferences?.[event.key] ?? true,
  }));
}
