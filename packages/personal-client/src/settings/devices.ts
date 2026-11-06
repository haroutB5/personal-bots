import type { PersonalDevice } from "@t3tools/contracts";

import { formatRelativeTime } from "../bots/relativeTime.ts";

export interface DeviceRow {
  readonly sessionId: string;
  readonly title: string;
  readonly detail: string;
  readonly relationship: PersonalDevice["relationship"];
  readonly canRevoke: boolean;
}

export function deviceKindLabel(device: PersonalDevice): string {
  switch (device.deviceType) {
    case "mobile":
      return "Phone";
    case "tablet":
      return "Tablet";
    case "desktop":
      return "Browser";
    case "bot":
      return "Bot";
    case "unknown":
      return "Device";
  }
}

/** "This device · Now" or "Phone · Android · Last seen 5m ago". */
export function deviceRow(device: PersonalDevice, now: number): DeviceRow {
  const kind = deviceKindLabel(device);
  const lastSeen =
    device.lastSeenAt === null
      ? `Signed in ${formatRelativeTime(device.signedInAt.epochMilliseconds, now)}`
      : `Last seen ${formatRelativeTime(device.lastSeenAt.epochMilliseconds, now)}`;
  const detail =
    device.relationship === "this-device"
      ? `This device · ${lastSeen}`
      : [kind, device.os, lastSeen].filter((part) => part !== null && part.length > 0).join(" · ");
  return {
    sessionId: device.sessionId,
    title: device.label,
    detail,
    relationship: device.relationship,
    canRevoke: device.relationship === "other",
  };
}

export function deviceRows(devices: readonly PersonalDevice[], now: number): DeviceRow[] {
  return devices.map((device) => deviceRow(device, now));
}
