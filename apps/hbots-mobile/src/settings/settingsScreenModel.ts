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

/** The name row stays blank until the profile loads; "Not set" means a loaded, empty name. */
export function nameRowValue(profile: PersonalProfile | null): string | undefined {
  if (profile === null) return undefined;
  const name = profile.displayName.trim();
  return name.length === 0 ? "Not set" : name;
}

/** The root screen's search keeps a row when its title, hint or keywords contain the words typed. */
export function settingsRowMatches(row: SettingsSearchRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return `${row.title} ${row.hint ?? ""} ${row.keywords ?? ""}`.toLowerCase().includes(needle);
}

export interface SettingsRowDefinition {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly keywords: string;
}

export interface SettingsSectionDefinition {
  readonly id: string;
  readonly label: string;
  readonly rows: ReadonlyArray<SettingsRowDefinition>;
}

/**
 * The one list of settings rows. Ids are unique across every section: a row
 * may move, but there is never a second row for the same thing. The screen
 * draws a row by its id, and the search reads these titles, hints and
 * keywords so a hidden section cannot keep a stale match.
 */
export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSectionDefinition> = [
  {
    id: "you",
    label: "You",
    rows: [
      {
        id: "you.name",
        title: "Your name",
        hint: "How your bots address you, and your name on the Team screen",
        keywords: "profile display name",
      },
      {
        id: "you.phone",
        title: "This phone",
        hint: "Update, permissions and this device",
        keywords: "version app install device",
      },
      {
        id: "you.notifications",
        title: "Notifications",
        hint: "Alerts on this phone when bots finish or need you",
        keywords: "push alerts",
      },
    ],
  },
  {
    id: "bots",
    label: "Bots",
    rows: [
      {
        id: "bots.team",
        title: "Team",
        hint: "See how your bots work together",
        keywords: "diagram org",
      },
      { id: "bots.new", title: "New bot", hint: "", keywords: "create add" },
      {
        id: "bots.routines",
        title: "Routines",
        hint: "Scheduled work for your bots",
        keywords: "schedule automation",
      },
      {
        id: "bots.memory",
        title: "Memory",
        hint: "What bots remember, and deleting it",
        keywords: "remember tidy",
      },
      {
        id: "bots.removed",
        title: "Removed bots",
        hint: "Bots a team lead removed, and bringing them back",
        keywords: "restore deleted",
      },
    ],
  },
  {
    id: "chat",
    label: "Chat",
    rows: [
      {
        id: "chat.toolSteps",
        title: "Show tool steps",
        hint: 'The compact work rows showing what a bot did between replies, like "Ran 3 commands".',
        keywords: "commands work rows",
      },
      {
        id: "chat.routinesStrip",
        title: "Show routines in chats",
        hint: "The Routines strip under a chat, listing that bot's scheduled work.",
        keywords: "schedule strip",
      },
      {
        id: "chat.autoArchive",
        title: "Auto-archive finished task and routine chats",
        hint: "Finished chats archive after a set time unused. Nothing is deleted.",
        keywords: "archive cleanup",
      },
      {
        id: "chat.archiveAfter",
        title: "Archive after",
        hint: "Time unused before a finished chat archives. 5m to 720h.",
        keywords: "archive time",
      },
    ],
  },
  {
    id: "voice",
    label: "Voice calls",
    rows: [
      {
        id: "voice.calls",
        title: "Voice calls",
        hint: "Gemini key, voice, languages and hang-up timing",
        keywords: "gemini key language hang up quiet",
      },
    ],
  },
  {
    id: "providers",
    label: "Providers",
    rows: [
      {
        id: "providers.versions",
        title: "Providers",
        hint: "Versions, updates and adding a provider",
        keywords: "version update install",
      },
    ],
  },
  {
    id: "privacy",
    label: "Privacy and security",
    rows: [
      {
        id: "privacy.connections",
        title: "Connections",
        hint: "GitHub, Vercel and other accounts bots can use",
        keywords: "github vercel accounts",
      },
      {
        id: "privacy.passwords",
        title: "Passwords",
        hint: "Saved website logins and bot grants",
        keywords: "logins websites",
      },
      {
        id: "privacy.apiKeys",
        title: "API keys",
        hint: "Keys bots can use, like Tavily and SerpApi",
        keywords: "secrets developer",
      },
    ],
  },
  {
    id: "about",
    label: "About",
    rows: [
      {
        id: "about.server",
        title: "Server",
        hint: "The computer hosting your bots",
        keywords: "address host",
      },
    ],
  },
];

/**
 * The sections the search leaves visible. A row in `hiddenRowIds` is gone
 * before the section check, and a section with no rows left is dropped.
 */
export function visibleSettingsSections(
  query: string,
  hiddenRowIds: ReadonlySet<string> = new Set(),
): ReadonlyArray<{
  readonly section: SettingsSectionDefinition;
  readonly rows: ReadonlyArray<SettingsRowDefinition>;
}> {
  return SETTINGS_SECTIONS.map((section) => ({
    section,
    rows: section.rows.filter((row) => !hiddenRowIds.has(row.id) && settingsRowMatches(row, query)),
  })).filter((entry) => entry.rows.length > 0);
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
