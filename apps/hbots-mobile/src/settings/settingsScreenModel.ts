import type {
  PersonalProfile,
  PersonalPushDevice,
  PersonalPushPreferences,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  PERSONAL_CHAT_ARCHIVE_AFTER_ERROR,
  formatPersonalChatArchiveAfterDuration,
  personalChatArchiveAfterDurationLabel,
  personalChatArchiveAfterMinutesValid,
  parsePersonalChatArchiveAfterDuration,
} from "@t3tools/contracts";
import { sharedPreferencesFromProfile } from "@hbots/personal-client/settings/profilePreferences";
import { formatRelativeTime } from "@hbots/personal-client/bots/relativeTime";

export interface SettingsSearchRow {
  readonly title: string;
  readonly hint?: string;
  readonly keywords?: string;
}

/** The root screen's search keeps a row when its title or hint contains the words typed. */
export function settingsRowMatches(row: SettingsSearchRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return `${row.title} ${row.hint ?? ""} ${row.keywords ?? ""}`.toLowerCase().includes(needle);
}

export const NOTIFICATION_EVENTS: ReadonlyArray<{
  readonly key: keyof PersonalPushPreferences;
  readonly label: string;
}> = [
  { key: "taskCompleted", label: "A bot finishes a task" },
  { key: "taskNeedsInput", label: "A bot needs your input or approval" },
  { key: "taskFailed", label: "A task fails" },
  { key: "routineResult", label: "A routine finishes" },
  { key: "chatReply", label: "A bot replies in a chat you are not reading" },
];

export function notificationDevicesLine(device: PersonalPushDevice): string {
  const label = device.deviceLabel.trim().length > 0 ? device.deviceLabel : "Device";
  return `${label} · ${device.endpointHost}`;
}

export function notificationDeviceDetail(device: PersonalPushDevice, now: number): string {
  if (device.lastError !== null && device.lastFailureAt !== null) {
    return `Last attempt failed ${formatRelativeTime(DateTime.toEpochMillis(device.lastFailureAt), now)}: ${device.lastError}`;
  }
  if (device.lastSuccessAt !== null) {
    return `Last delivered ${formatRelativeTime(DateTime.toEpochMillis(device.lastSuccessAt), now)}`;
  }
  return "Nothing sent yet";
}

export function sharedPreferencesOf(profile: PersonalProfile | null) {
  return sharedPreferencesFromProfile(profile);
}

/** The Auto-archive row label: on unless the profile says off. */
export function autoArchiveEnabled(profile: PersonalProfile | null): boolean {
  return profile?.autoArchiveTaskChats ?? true;
}

/** The number of minutes stored for a finished chat, defaulting to 48 hours. */
export function autoArchiveMinutes(profile: PersonalProfile | null): number {
  const stored = profile?.autoArchiveTaskChatsAfterMinutes;
  if (stored === undefined) return 48 * 60;
  return personalChatArchiveAfterMinutesValid(stored) ? stored : 48 * 60;
}

export function autoArchiveHint(minutes: number): string {
  return `Finished task and routine-run chats archive after ${personalChatArchiveAfterDurationLabel(
    minutes,
  )} unused. Nothing is deleted.`;
}

export function autoArchiveFieldValue(minutes: number): string {
  return formatPersonalChatArchiveAfterDuration(minutes);
}

export type AutoArchiveDraft =
  | { readonly kind: "valid"; readonly minutes: number }
  | { readonly kind: "invalid"; readonly message: string };

export function parseAutoArchiveDraft(text: string): AutoArchiveDraft {
  const minutes = parsePersonalChatArchiveAfterDuration(text);
  if (minutes === null || !personalChatArchiveAfterMinutesValid(minutes)) {
    return { kind: "invalid", message: PERSONAL_CHAT_ARCHIVE_AFTER_ERROR };
  }
  return { kind: "valid", minutes };
}

export function settingsVersionValue(installedVersion: string): string {
  return installedVersion.trim().length > 0 ? installedVersion : "Development build";
}
