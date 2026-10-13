import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isBotPinned,
  type PersonalBot,
  type PersonalBotThread,
  type PersonalGroup,
  type PersonalGroupRound,
} from "@t3tools/contracts";

import { botStatus, type BotSummary } from "./botSummaries";
import { chatActivityMs } from "./chatActivity";
import { isChatPinned, isChatSnoozed } from "./chatState";
import { plainPreviewLine } from "./BotRow";
import { groupLastActivityMs, isGroupRelayLink, isGroupRoundLive } from "./groupModel";
import { HIDDEN_PREVIEW_LABEL, HIDDEN_WORKING_LABEL, hidesBotPreviews } from "./previewPrivacy";
import type { NeedsYouModel, NeedsYouRequest } from "./needsYou";
import { isChatUnread, type ChatSeenState, NO_CHAT_SEEN } from "./unreadChats";

/**
 * The Bots home's row model: one 72px row per chat, groups among them, plus
 * the rail's pinned cards and bot tiles.
 *
 * Everything a row draws comes from data the list already carries (the thread
 * link, the thread shell, the bot record), so the home opens no per-row
 * request. The module is pure and is called once per store change by the
 * screen's own `useMemo`s; the needs-you model is passed in, never rebuilt
 * here, so the chip, the badge and the pill read one derivation.
 */

/** The filters, in the order the chips are drawn. */
export type HomeFilter = "all" | "needs" | "unread" | "groups";

export const HOME_FILTERS: ReadonlyArray<{ readonly key: HomeFilter; readonly label: string }> = [
  { key: "all", label: "All" },
  { key: "needs", label: "Needs you" },
  { key: "unread", label: "Unread" },
  { key: "groups", label: "Groups" },
];

/** How a row's preview reads: a working line (green), a thinking line (grey) or plain text. */
export type RowPreviewTone = "working" | "thinking" | "plain";

export interface HomeChatRow {
  readonly kind: "chat";
  /** The thread id. */
  readonly key: string;
  readonly link: PersonalBotThread;
  readonly shell: EnvironmentThreadShell;
  readonly bot: PersonalBot;
  readonly title: string;
  readonly activityMs: number;
  readonly unread: boolean;
  readonly pinned: boolean;
  /** The chat's highest-priority open request, or null. */
  readonly request: NeedsYouRequest | null;
}

export interface HomeGroupRow {
  readonly kind: "group";
  readonly key: string;
  readonly group: PersonalGroup;
  readonly round: PersonalGroupRound | null;
  readonly activityMs: number;
  readonly pinned: boolean;
  readonly request: NeedsYouRequest | null;
}

export type HomeRow = HomeChatRow | HomeGroupRow;

export interface HomeRowsInput {
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly links: ReadonlyArray<PersonalBotThread>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  /** Groups that are not archived. */
  readonly groups: ReadonlyArray<PersonalGroup>;
  readonly rounds: ReadonlyArray<PersonalGroupRound>;
  /** Group relay threads (`groupRelayThreadIds`): never rows of their own. */
  readonly relayThreadIds: ReadonlySet<string>;
  readonly needsYou: NeedsYouModel;
  readonly nowMs: number;
  readonly seen?: ChatSeenState | undefined;
}

/** A chat row before the needs-you model is joined onto it. */
export type HomeChatBase = Omit<HomeChatRow, "request">;

/**
 * Every chat the home lists: open, awake, and not a group's private relay.
 * Snoozed chats are not here (they wait in the Snoozed section), and neither
 * are archived ones (they live on the bot's own page). The needs-you model is
 * derived from these (see {@link deriveNeedsYou}), so the rows and the count
 * can never come from two different sets of chats.
 */
export function homeChatBases(
  input: Omit<HomeRowsInput, "needsYou" | "groups" | "rounds">,
): HomeChatBase[] {
  const botsById = new Map(input.bots.map((bot) => [bot.botId as string, bot] as const));
  const shellsById = new Map(input.shells.map((shell) => [shell.id as string, shell] as const));
  const seen = input.seen ?? NO_CHAT_SEEN;
  const rows: HomeChatBase[] = [];
  for (const link of input.links) {
    if (link.archivedAt !== null) continue;
    if (isGroupRelayLink(link, input.relayThreadIds)) continue;
    const bot = botsById.get(link.botId);
    const shell = shellsById.get(link.threadId);
    if (bot === undefined || shell === undefined || shell.archivedAt !== null) continue;
    if (isChatSnoozed(link, input.nowMs)) continue;
    rows.push({
      kind: "chat",
      key: link.threadId as string,
      link,
      shell,
      bot,
      title: shell.title,
      activityMs: chatActivityMs(shell, link),
      unread: isChatUnread(link, seen, shell),
      pinned: isChatPinned(link),
    });
  }
  return rows;
}

/**
 * The home's rows, chats and groups interleaved by when they last spoke, as
 * the design draws them, with the needs-you model's request joined on. Ties:
 * pinned first, then the alphabetical key, so the order never depends on the
 * shape of the input array.
 */
export function buildHomeRows(input: {
  readonly chatBases: ReadonlyArray<HomeChatBase>;
  readonly groups: ReadonlyArray<PersonalGroup>;
  readonly rounds: ReadonlyArray<PersonalGroupRound>;
  readonly needsYou: NeedsYouModel;
  readonly nowMs: number;
}): HomeRow[] {
  const rows: HomeRow[] = input.chatBases.map((base) => ({
    ...base,
    request: input.needsYou.byRow.get(base.key)?.[0] ?? null,
  }));
  for (const group of input.groups) {
    if (isChatSnoozed(group, input.nowMs)) continue;
    rows.push({
      kind: "group",
      key: group.groupId,
      group,
      round: input.rounds.find((round) => round.groupId === group.groupId) ?? null,
      activityMs: groupLastActivityMs(group, input.nowMs),
      pinned: isChatPinned(group),
      request: input.needsYou.byRow.get(group.groupId)?.[0] ?? null,
    });
  }
  return rows.toSorted((left, right) => {
    if (left.activityMs !== right.activityMs) return right.activityMs - left.activityMs;
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return left.key.localeCompare(right.key);
  });
}

/**
 * The rows a filter shows.
 *
 * `all` leaves the pinned rows out: they are in the rail, and a chat that is
 * pinned is not listed twice (design decision 4). The other filters do include
 * them, so a pinned chat that needs an answer is one tap from the chip that
 * says so.
 */
export function filterHomeRows(
  rows: ReadonlyArray<HomeRow>,
  filter: HomeFilter,
): ReadonlyArray<HomeRow> {
  switch (filter) {
    case "all":
      return rows.filter((row) => !row.pinned);
    case "needs":
      return rows.filter((row) => row.request !== null);
    case "unread":
      // Groups carry no unread flag (the server marks chat links only), so
      // this filter is the chats'.
      return rows.filter((row) => row.kind === "chat" && row.unread);
    case "groups":
      return rows.filter((row) => row.kind === "group");
  }
}

/** Client-side search over row titles, bot names and group members. */
export function searchHomeRows(
  rows: ReadonlyArray<HomeRow>,
  query: string,
  nameOf: (botId: string) => string | null,
): HomeRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return [...rows];
  return rows.filter((row) => {
    const texts =
      row.kind === "chat"
        ? [row.title, row.bot.name]
        : [row.group.name, ...row.group.members.map((member) => nameOf(member.botId) ?? "")];
    return texts.some((text) => text.toLocaleLowerCase().includes(needle));
  });
}

/** What the list draws: the rows the filter and the search leave. */
export function visibleHomeRows(input: {
  readonly rows: ReadonlyArray<HomeRow>;
  readonly filter: HomeFilter;
  readonly query: string;
  readonly nameOf: (botId: string) => string | null;
}): HomeRow[] {
  // A search looks at everything: the owner typing a name wants the chat, not
  // the chat only if the chip they left selected happens to include it.
  if (input.query.trim().length > 0) {
    return searchHomeRows(input.rows, input.query, input.nameOf);
  }
  return [...filterHomeRows(input.rows, input.filter)];
}

/** The count on the "Needs you" chip and the tab badge: the open requests. */
export function needsYouCount(model: NeedsYouModel): number {
  return model.count;
}

/**
 * The rail's cards: the pinned chats, newest first. A pinned group is a chat
 * too, so it rides here the same way. Nothing is capped: the rail scrolls.
 */
export function railCards(rows: ReadonlyArray<HomeRow>): HomeRow[] {
  return rows
    .filter((row) => row.pinned)
    .toSorted((left, right) => right.activityMs - left.activityMs);
}

/**
 * The rail's bot tiles, in order: the pinned bots first (the bot form's "Pin
 * to top" still means something), then by latest activity, then the sort order
 * the Team screen uses, then the name. Bots that live only inside their groups
 * have no chats of their own: the caller passes the shown ones.
 */
export function railBots(summaries: ReadonlyArray<BotSummary>): BotSummary[] {
  return summaries.toSorted((left, right) => {
    const pinnedLeft = isBotPinned(left.bot);
    const pinnedRight = isBotPinned(right.bot);
    if (pinnedLeft !== pinnedRight) return pinnedLeft ? -1 : 1;
    const byActivity = (right.lastActivityMs ?? -1) - (left.lastActivityMs ?? -1);
    if (byActivity !== 0) return byActivity;
    if (left.bot.sortOrder !== right.bot.sortOrder) return left.bot.sortOrder - right.bot.sortOrder;
    return left.bot.name.localeCompare(right.bot.name);
  });
}

/**
 * A rail tile's caption: the state in words, in the state's colour, as the
 * design draws it ("Working", "Thinking", "Needs you"), and the model family
 * when the bot is idle. The same words go in the aria-label.
 */
export interface RailCaption {
  readonly label: string;
  readonly tone: "working" | "thinking" | "needs" | "idle";
}

export function railCaption(input: {
  readonly summary: BotSummary;
  readonly now: number;
  /** The bot has an open request in one of its chats (the needs-you model). */
  readonly needsYou: boolean;
  /** Its live turn has produced nothing yet (the tool-aware `thinking`). */
  readonly thinking: boolean;
}): RailCaption {
  if (input.needsYou) return { label: "Needs you", tone: "needs" };
  if (input.summary.live) {
    return input.thinking
      ? { label: "Thinking", tone: "thinking" }
      : { label: "Working", tone: "working" };
  }
  const model = input.summary.modelShortLabel;
  if (model !== null) return { label: model, tone: "idle" };
  const status = botStatus(input.summary, input.now);
  return { label: status.label, tone: status.tone === "review" ? "needs" : "idle" };
}

/** The rail card's caption: the same state words, off the row's own request. */
export function cardCaption(input: {
  readonly row: HomeRow;
  /** The card's row preview tone, when it is live. */
  readonly tone: RowPreviewTone;
  readonly live: boolean;
  readonly round: PersonalGroupRound | null;
  /** The bot's short model label, for an idle chat card ("Opus 5.5"). */
  readonly modelLabel: string | null;
}): RailCaption {
  if (input.row.request !== null) return { label: "Needs you", tone: "needs" };
  const live = input.live || (input.row.kind === "group" && isGroupRoundLive(input.round));
  if (live) {
    return input.tone === "thinking"
      ? { label: "Thinking", tone: "thinking" }
      : { label: "Working", tone: "working" };
  }
  if (input.modelLabel !== null) return { label: input.modelLabel, tone: "idle" };
  return { label: "", tone: "idle" };
}

/**
 * A chat row's preview line and its tone. The owner's hidden-preview rule wins
 * over everything: no message words ever leave the server for such a bot.
 */
export function chatRowPreview(input: {
  readonly row: HomeChatRow;
  readonly progressNote?: string | null | undefined;
  readonly thinking: boolean;
}): { readonly text: string; readonly tone: RowPreviewTone } {
  const { row } = input;
  const hidden = hidesBotPreviews(row.bot) || row.link.newestMessage?.hidden === true;
  if (hidden) {
    const live = isChatRowLive(row);
    return {
      text: live ? HIDDEN_WORKING_LABEL : HIDDEN_PREVIEW_LABEL,
      tone: live ? "working" : "plain",
    };
  }
  if (isChatRowLive(row)) {
    if (input.progressNote != null && input.progressNote.length > 0) {
      return { text: input.progressNote, tone: "working" };
    }
    return input.thinking
      ? { text: "Thinking", tone: "thinking" }
      : { text: "Working", tone: "working" };
  }
  const message = row.link.newestMessage;
  if (message != null) {
    const line = message.text
      .split("\n")
      .map((part) => plainPreviewLine(part))
      .find((part) => part.length > 0);
    if (line !== undefined) return { text: line, tone: "plain" };
  }
  return { text: "No messages yet", tone: "plain" };
}

/** A chat has a turn or a session running right now (its shell's own words). */
export function isChatRowLive(row: Pick<HomeChatRow, "shell">): boolean {
  return (
    row.shell.latestTurn?.state === "running" ||
    row.shell.session?.status === "running" ||
    row.shell.session?.status === "starting"
  );
}
