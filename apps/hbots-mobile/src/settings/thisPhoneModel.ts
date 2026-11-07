import type { PersonalPushDevice } from "@t3tools/contracts";

/** Notifications are "On" only when a registered push device carries this phone's label. */
export function phoneNotificationState(
  devices: ReadonlyArray<PersonalPushDevice> | null,
  label: string,
): "On" | "Off" | "…" {
  if (devices === null) return "…";
  return devices.some((device) => device.deviceLabel === label) ? "On" : "Off";
}
