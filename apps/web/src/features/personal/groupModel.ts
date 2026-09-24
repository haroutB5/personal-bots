import {
  isBotPinned,
  isTeamLead,
  personalBotTeamLabel,
  PERSONAL_GROUP_MESSAGE_CONTEXT_KIND,
  PersonalGroupMessageMarker,
  type OrchestrationMessageContext,
  type PersonalBot,
  type PersonalGroup,
  type PersonalGroupRound,
  type PersonalGroupSystemEvent,
  type PersonalGroupVote,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeMarker = Schema.decodeUnknownOption(PersonalGroupMessageMarker);

/**
 * The group-service marker behind a message, or null when there is none.
 *
 * The mirror of {@link readServerTurn} for groups: attribution rides on the
 * message's own `context` (see `PERSONAL_GROUP_MESSAGE_CONTEXT_KIND`), so who
 * spoke survives paging, needs no join, and is right offline. A message with no
 * marker — everything written before groups existed, and everything the owner
 * types — falls back to plain rendering, which is why this returns null rather
 * than throwing on a shape it does not recognise.
 */
export function readGroupMarker(message: {
  readonly context?: OrchestrationMessageContext | undefined;
}): PersonalGroupMessageMarker | null {
  for (const record of message.context?.records ?? []) {
    if (record.kind !== PERSONAL_GROUP_MESSAGE_CONTEXT_KIND || !("payload" in record)) continue;
    const marker = decodeMarker(record.payload);
    // A record of the right kind whose payload does not decode is a marker
    // this build does not understand: render the message plainly rather than
    // guess at a speaker.
    return Option.isNone(marker) ? null : marker.value;
  }
  return null;
}

/** Members that have not left, in their `sortOrder`. */
export function activeGroupMembers(group: PersonalGroup): PersonalGroup["members"] {
  return group.members
    .filter((member) => member.leftAt === null)
    .toSorted((left, right) => left.sortOrder - right.sortOrder);
}

/**
 * The member threads every group owns, so the Chats list can hide them from
 * the bots' own chat lists: a member thread is the bot's private relay of the
 * group, not a chat the owner started, and showing it would put the same
 * conversation on screen twice.
 */
export function groupMemberThreadIds(groups: ReadonlyArray<PersonalGroup>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const member of group.members) {
      if (member.threadId !== null) ids.add(member.threadId as string);
    }
  }
  return ids;
}

/** "Ada, Grace and Alan" — the member names under a group's name in the list. */
export function groupSubtitle(
  group: PersonalGroup,
  nameOf: (botId: string) => string | null,
): string {
  const names = activeGroupMembers(group).flatMap((member) => {
    const name = nameOf(member.botId);
    return name === null ? [] : [name];
  });
  if (names.length === 0) return "No bots yet";
  return names.join(", ");
}

/** Client-side search over group names and their members' names. */
export function filterGroups(
  groups: ReadonlyArray<PersonalGroup>,
  query: string,
  nameOf: (botId: string) => string | null,
): ReadonlyArray<PersonalGroup> {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return groups;
  return groups.filter(
    (group) =>
      group.name.toLocaleLowerCase().includes(needle) ||
      activeGroupMembers(group).some((member) =>
        (nameOf(member.botId) ?? "").toLocaleLowerCase().includes(needle),
      ),
  );
}

/**
 * Newest activity in a group, in epoch ms.
 *
 * The group's own `updatedAt`, not the newest message's time:
 * `PersonalBotThreadNewestMessage` carries no timestamp (it exists to preview
 * text, not to order rows), and inventing one from the round would leave a
 * group that has only ever been renamed with no time at all.
 */
export function groupLastActivityMs(group: PersonalGroup): number {
  return DateTime.toEpochMillis(group.updatedAt);
}

/** One line of the newest message, for the group row's preview. */
export function groupPreviewLine(group: PersonalGroup): string {
  const text = group.newestMessage?.text ?? "";
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? "No messages yet";
}

/** The round a group is currently in, or null when none is live. */
export function roundForGroup(
  rounds: ReadonlyArray<PersonalGroupRound>,
  groupId: string,
): PersonalGroupRound | null {
  return rounds.find((round) => round.groupId === groupId) ?? null;
}

const GROUP_ROUND_RUNNING: ReadonlySet<PersonalGroupRound["status"]> = new Set([
  "running",
  // Parked on a provider's clock, not finished: the sweep will wake it, so the
  // group is still the round's, and Stop is still the meaningful action.
  "waiting_provider",
]);

/** A round that still owns the group: the composer offers Stop, not Send. */
export function isGroupRoundLive(round: PersonalGroupRound | null): boolean {
  return round !== null && GROUP_ROUND_RUNNING.has(round.status);
}

/**
 * One line for a group row's status, in the vocabulary the bot rows already
 * use. Nothing is invented: a group with no live round is "Ready".
 */
export function groupStatusLine(
  round: PersonalGroupRound | null,
  nameOf: (botId: string) => string | null,
): { readonly label: string; readonly tone: "review" | "normal" } {
  if (round === null) return { label: "Ready", tone: "normal" };
  switch (round.status) {
    case "running": {
      const speaking = round.activeBotId === null ? null : nameOf(round.activeBotId);
      return { label: speaking === null ? "Working" : `${speaking} is replying`, tone: "normal" };
    }
    case "waiting_provider":
      return { label: "Rate limited", tone: "review" };
    case "paused_budget":
      return { label: "Paused · tap to continue", tone: "review" };
    case "paused_vote":
      return { label: "Waiting on your decision", tone: "review" };
    case "stopped":
    case "interrupted":
    case "completed":
      return { label: "Ready", tone: "normal" };
  }
}

/** Sentences for the system rows the group service writes into the transcript. */
const SYSTEM_EVENT_TEXT: Record<PersonalGroupSystemEvent, string> = {
  "member-added": "joined the group",
  "member-removed": "left the group",
  "member-skipped": "was skipped",
  "member-dropped": "was dropped from this round",
  "round-paused-budget": "The group used its replies for this message",
  "round-stopped": "You stopped the group",
  "round-interrupted": "The group was interrupted",
  "round-ended-loop": "The bots were going back and forth, so the round ended",
  "stray-turn-stopped": "A turn started outside the group was stopped",
  "vote-opened": "A vote was opened",
  "vote-resolved": "The vote resolved",
  "vote-approved": "You approved the vote",
  "vote-rejected": "You rejected the vote",
};

/**
 * The label for a system row. The server writes the real sentence into the
 * message text, so that is preferred; this is the fallback for a row whose text
 * did not survive (and the vocabulary a future event lands in).
 */
export function groupSystemLabel(event: PersonalGroupSystemEvent, text: string): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? SYSTEM_EVENT_TEXT[event];
}

export interface GroupRoundCardModel {
  readonly tone: "review" | "neutral";
  readonly title: string;
  readonly detail: string | null;
  /** Label for the single action, or null when the card only reports. */
  readonly action: "Continue" | "Retry" | null;
}

/**
 * The inline card for a round that stopped short. Null for every round the
 * owner has nothing to do about — a running round is the transcript itself,
 * and a completed one needs no card.
 */
export function groupRoundCard(
  round: PersonalGroupRound | null,
  nameOf: (botId: string) => string | null,
): GroupRoundCardModel | null {
  if (round === null) return null;
  switch (round.status) {
    case "paused_budget":
      return {
        tone: "review",
        title: "Paused after the replies this message was given",
        detail: "The bots can keep going if you want them to.",
        action: "Continue",
      };
    case "waiting_provider": {
      const who = round.activeBotId === null ? null : nameOf(round.activeBotId);
      return {
        tone: "review",
        title: `${who ?? "A bot"} is rate limited`,
        detail: round.errorMessage,
        action: "Retry",
      };
    }
    case "stopped":
      return { tone: "neutral", title: "You stopped the group", detail: null, action: null };
    case "interrupted":
      return {
        tone: "neutral",
        title: "The group was interrupted",
        detail: round.errorMessage ?? "Send a message to start it again.",
        action: null,
      };
    case "running":
    case "paused_vote":
    case "completed":
      return null;
  }
}

export interface GroupVoteBallotRow {
  readonly botId: string;
  readonly name: string;
  readonly option: string;
  /** One line, as the bot gave it. Empty when it voted without saying why. */
  readonly reason: string;
}

export interface GroupVoteCardModel {
  readonly voteId: string;
  readonly question: string;
  /** The single sentence above the ballots: what the group chose, or a tie. */
  readonly outcome: string;
  readonly winningOption: string | null;
  /** One row per member that voted, in the group's own member order. */
  readonly ballots: ReadonlyArray<GroupVoteBallotRow>;
  /** Members that never voted, by name. Said out loud, not folded into a count. */
  readonly abstained: ReadonlyArray<string>;
  /**
   * False on a tie: there is no winning option, so there is nothing to
   * approve, and the server refuses it. Reject is always offered.
   */
  readonly canApprove: boolean;
}

/**
 * The tally the owner is being asked to answer, or null.
 *
 * Only ever rendered for a round parked on `paused_vote`, which is exactly the
 * status {@link groupRoundCard} returns null for, so the two cards can never
 * both be on screen.
 *
 * It shows every member's choice WITH its reason, because a plurality is not
 * an argument: the owner is deciding whether work happens, and the reasons are
 * most of what that decision rests on. Nothing here can act — the card's two
 * buttons are the only way a vote ever becomes an instruction.
 */
export function groupVoteCard(input: {
  readonly round: PersonalGroupRound | null;
  readonly votes: ReadonlyArray<PersonalGroupVote>;
  readonly members: PersonalGroup["members"];
  readonly nameOf: (botId: string) => string | null;
}): GroupVoteCardModel | null {
  const round = input.round;
  if (round === null || round.status !== "paused_vote") return null;
  // This round's tally, never a neighbouring round's: a vote the owner already
  // answered, or one left over from an earlier message, is not a question.
  const vote = input.votes.find(
    (candidate) => candidate.roundId === round.roundId && candidate.status === "decided",
  );
  if (vote === undefined) return null;

  const ballots: Array<GroupVoteBallotRow> = [];
  const abstained: Array<string> = [];
  for (const member of input.members) {
    const name = input.nameOf(member.botId) ?? "A bot";
    const ballot = vote.ballots.find((entry) => entry.botId === member.botId);
    if (ballot === undefined) {
      abstained.push(name);
      continue;
    }
    ballots.push({ botId: member.botId, name, option: ballot.option, reason: ballot.reason });
  }

  return {
    voteId: vote.voteId,
    question: vote.question,
    outcome:
      vote.winningOption === null
        ? "The bots are tied, so they chose nothing."
        : `The bots chose "${vote.winningOption}".`,
    winningOption: vote.winningOption,
    ballots,
    abstained,
    canApprove: vote.winningOption !== null,
  };
}

/** One member row in the Delete group sheet. */
export interface GroupDeleteCandidate {
  readonly botId: string;
  readonly name: string;
  /**
   * Ticked by default. Always false: deleting a group keeps its bots unless the
   * owner ticks them, and a bot this group alone held moves back to the Bots
   * list rather than going with it.
   */
  readonly checked: boolean;
  /** Why this bot matters outside the group, shown on the row. Null when nothing does. */
  readonly reason: string | null;
}

/**
 * The Delete group sheet's rows. Nothing starts ticked: the default keeps
 * every bot (a group-only bot moves back to the Bots list).
 *
 * Three things are named on a row, so the owner sees what ticking it would
 * cost outside this group:
 *
 * 1. **It leads a team.** Assistant leads the assistant team, CTO the dev team.
 *    Scrapping a group must never quietly take the lead of a team with it.
 * 2. **It is pinned in Chats**, i.e. the owner has already said it matters.
 * 3. **It is in another group too.** Deleting it would rewrite a conversation
 *    the owner is not looking at.
 *
 * Every row can still be ticked by hand. A tap-through destroys no bot.
 */
export function groupDeleteCandidates(input: {
  readonly group: PersonalGroup;
  readonly groups: ReadonlyArray<PersonalGroup>;
  readonly bots: ReadonlyArray<PersonalBot>;
}): ReadonlyArray<GroupDeleteCandidate> {
  const byId = new Map(input.bots.map((bot) => [bot.botId as string, bot] as const));
  const others = input.groups.filter((group) => group.groupId !== input.group.groupId);

  return activeGroupMembers(input.group).map((member) => {
    const bot = byId.get(member.botId);
    if (bot === undefined) {
      // A member whose bot row the client has not loaded: never tick something
      // that cannot be named, because the confirmation would be a lie.
      return { botId: member.botId, name: member.botId, checked: false, reason: "Still loading" };
    }
    const alsoIn = others.filter((group) =>
      activeGroupMembers(group).some((entry) => entry.botId === member.botId),
    );
    const reason =
      isTeamLead(bot) && bot.team !== undefined
        ? `Leads the ${personalBotTeamLabel(bot.team)}`
        : isTeamLead(bot)
          ? "Leads a team"
          : isBotPinned(bot)
            ? "Pinned in Chats"
            : alsoIn.length === 1
              ? `Also in ${alsoIn[0]!.name}`
              : alsoIn.length > 1
                ? `Also in ${String(alsoIn.length)} other groups`
                : null;
    return { botId: member.botId, name: bot.name, checked: false, reason };
  });
}

/**
 * The one line above the destructive button. It names the count, and says
 * plainly that the chats go too, because they do and nothing brings them back.
 */
export function groupDeleteSummary(ticked: number): string {
  if (ticked === 0) {
    return "Deletes the group and its conversation. Its bots are kept and move back to your Bots list.";
  }
  return ticked === 1
    ? "Deletes the group and 1 bot with its chats."
    : `Deletes the group and ${String(ticked)} bots with their chats.`;
}
