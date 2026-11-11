import type { PersonalPushPreferences } from "@t3tools/contracts";

import type { ChannelState } from "../notifications/nativeNotify";
import type { PermissionAnswer } from "../notifications/pushController";
import type { PushStatus } from "../notifications/pushState";
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

export interface ChannelRow {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}

/** What an Android importance level means to the person, in words. */
export function importanceText(importance: number): string {
  if (importance <= 0) return "Off";
  if (importance <= 2) return "Silent";
  if (importance === 3) return "Sound";
  return "Sound and pop-up";
}

const FIXED_ORDER: Readonly<Record<string, number>> = { account: 0 };

/** One row per channel that carries messages: sign-in first, then bots by name. */
export function channelRows(channels: ReadonlyArray<ChannelState>): ReadonlyArray<ChannelRow> {
  const owned = channels.filter(
    (channel) => channel.id in FIXED_ORDER || channel.id.startsWith("bot."),
  );
  return owned
    .toSorted((a, b) => {
      const rankA = FIXED_ORDER[a.id] ?? 2;
      const rankB = FIXED_ORDER[b.id] ?? 2;
      return rankA !== rankB ? rankA - rankB : a.name.localeCompare(b.name);
    })
    .map((channel) => ({
      id: channel.id,
      title: channel.name,
      detail: importanceText(channel.importance),
    }));
}

/** Test pushes are only worth sending once the phone is registered. */
export function canSendTest(status: PushStatus): boolean {
  return status.kind === "on";
}

export interface PermissionRow {
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string;
  readonly settingsLabel: string;
}

/**
 * Android's own switch for hbots notifications, whatever the build can register. A build without
 * Firebase still posts the working notice and the reply buttons, so a denied permission has to show
 * here with a way back. A build that can register shows the same thing in its push row, so this
 * stays out of its way.
 */
export function permissionRow(input: {
  readonly enabled: boolean;
  readonly push: PushStatus["kind"];
}): PermissionRow | null {
  if (input.enabled || input.push === "blocked") return null;
  return {
    title: "Notifications are off",
    body: "Android is blocking notifications from hbots. Turn them on to see when bots are working and to answer from the notification.",
    actionLabel: "Turn on",
    settingsLabel: "Open Android settings",
  };
}

export interface PermissionAskPort {
  request(): Promise<PermissionAnswer>;
  openSettings(): void;
}

/**
 * One button for both cases. Android shows its prompt again only while it still allows it; when it says
 * it will not (or the phone has no prompt, before Android 13) the only way on is the app's notification
 * settings, so open those.
 */
export async function askForNotifications(port: PermissionAskPort): Promise<PermissionAnswer> {
  const answer = await port.request();
  if (answer === "blocked" || answer === "not-needed") port.openSettings();
  return answer;
}
