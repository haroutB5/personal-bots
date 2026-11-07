import {
  botNotificationsMutedUntil,
  isIndefiniteMute,
  type PersonalBotNotificationMute,
} from "@t3tools/contracts";

/** Whether a bot's notifications are silenced now, and until when. */
export type BotMuteState =
  | { readonly muted: false }
  | { readonly muted: true; readonly indefinite: boolean; readonly untilMs: number };

export function botMuteState(
  bot: Parameters<typeof botNotificationsMutedUntil>[0],
  nowMs: number,
): BotMuteState {
  const untilMs = botNotificationsMutedUntil(bot, nowMs);
  return untilMs === null
    ? { muted: false }
    : { muted: true, indefinite: isIndefiniteMute(untilMs), untilMs };
}

/** The mute lengths offered everywhere a bot can be muted, as in messaging apps. */
export const MUTE_CHOICES: ReadonlyArray<{
  readonly key: "1h" | "8h" | "indefinitely";
  readonly label: string;
  readonly mute: PersonalBotNotificationMute;
}> = [
  { key: "1h", label: "For 1 hour", mute: { forMinutes: 60 } },
  { key: "8h", label: "For 8 hours", mute: { forMinutes: 8 * 60 } },
  { key: "indefinitely", label: "Until I turn it back on", mute: "indefinitely" },
];

const sameDay = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

/**
 * "Muted until 15:40", "Muted until tomorrow, 01:10", or "Muted until you turn
 * it back on", in the device's own time format.
 */
export function mutedUntilLabel(
  state: Extract<BotMuteState, { muted: true }>,
  nowMs: number,
  locale?: string,
): string {
  if (state.indefinite) return "Muted until you turn it back on";
  const until = new Date(state.untilMs);
  const now = new Date(nowMs);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    until,
  );
  if (sameDay(until, now)) return `Muted until ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(until, tomorrow)) return `Muted until tomorrow, ${time}`;
  const day = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(until);
  return `Muted until ${day}, ${time}`;
}

/**
 * The bot editor's Notifications select. "keep" is the mute the bot already
 * has (shown as "Muted until 15:40"), so saving other edits never restarts it.
 */
export type BotNotificationsChoice = "keep" | "on" | (typeof MUTE_CHOICES)[number]["key"];

/** Where the editor's select starts: on, or the bot's current mute. */
export function initialNotificationsChoice(
  bot: Parameters<typeof botNotificationsMutedUntil>[0] | null,
  nowMs: number,
): "keep" | "on" {
  return bot !== null && botMuteState(bot, nowMs).muted ? "keep" : "on";
}

/** What saving the editor sends for its select: nothing when it did not change. */
export function muteForChoice(
  choice: BotNotificationsChoice,
  initial: BotNotificationsChoice,
): PersonalBotNotificationMute | undefined {
  if (choice === initial || choice === "keep") return undefined;
  if (choice === "on") return "on";
  return MUTE_CHOICES.find((option) => option.key === choice)?.mute;
}
