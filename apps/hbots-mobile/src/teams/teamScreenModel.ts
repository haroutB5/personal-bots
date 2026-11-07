import type {
  PersonalBot,
  PersonalBotTeam,
  PersonalBotTokenUsageResult,
  PersonalBotTokenUsageWindowId,
  PersonalRemovedBot,
  PersonalTask,
} from "@t3tools/contracts";
import {
  botTeam,
  isGroupOnlyBot,
  isTeamLead,
  personalBotTeamLabel,
  sameTeam,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "@hbots/personal-client/bots/threadShell";

import { isThreadLive } from "@hbots/personal-client/bots/botSummaries";
import {
  buildTeamGroups,
  teamDropOutcome,
  type TeamDropBot,
  type TeamGroup,
} from "@hbots/personal-client/teams/teamDiagramModel";
import {
  leadersLeaving,
  leaderMoveWarning,
  planTeamMoves,
  teamCreatedMessage,
  teamNameProblem,
  type TeamMove,
} from "@hbots/personal-client/teams/newTeamModel";
import {
  leadConfirmCopy,
  replacedLead,
  teamMoveTargets,
  type LeadConfirmCopy,
  type LeadReplacement,
  type MoveTargetRow,
} from "@hbots/personal-client/teams/teamMoves";
import {
  mergeSeenRemovedBots,
  removedBotSubtitle,
  removedByLine,
  restoredMessage,
} from "@hbots/personal-client/teams/removedBotsModel";
import { deriveWorkingNow, formatWorkingFor } from "@hbots/personal-client/teams/teamWorkingNow";
import {
  buildTokenUsageTable,
  findTokenUsageWindow,
  formatSplit,
  formatUpdated,
  formatWindowSpan,
  isTokenUsagePending,
  splitOf,
  type TokenUsageTable,
} from "@hbots/personal-client/usage/tokenUsagePresentation";

/** One bot as a team card draws it: the lead first, then the members. */
export interface TeamMemberModel {
  readonly botId: string;
  readonly name: string;
  readonly avatarShape: PersonalBot["avatarShape"];
  readonly avatarColor: string;
  readonly modelLabel: string | null;
  readonly isLead: boolean;
  readonly live: boolean;
}

export interface TeamCardModel {
  readonly team: PersonalBotTeam;
  readonly label: string;
  readonly total: number;
  readonly members: ReadonlyArray<TeamMemberModel>;
  readonly custom: boolean;
  /** A custom team nobody is on: Remove is allowed, unlike a team with bots. */
  readonly removable: boolean;
}

/**
 * The bots the phone's team screen draws: group-only bots stay out, as on the
 * web, except one that leads a team.
 */
export function teamChartBots(bots: ReadonlyArray<PersonalBot>): ReadonlyArray<PersonalBot> {
  return bots
    .filter((bot) => !isGroupOnlyBot(bot) || isTeamLead(bot))
    .toSorted((left, right) => left.sortOrder - right.sortOrder);
}

/**
 * The team cards, in the shared grouping's order. A custom team with no bots
 * is still drawn, so its Remove action can be reached.
 */
export function teamCards(input: {
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly customTeams: ReadonlyArray<PersonalBotTeam>;
  readonly liveBotIds: ReadonlySet<string>;
  readonly modelLabelOf: (bot: PersonalBot) => string | null;
}): ReadonlyArray<TeamCardModel> {
  const botsById = new Map(input.bots.map((bot) => [bot.botId as string, bot] as const));
  const member = (botId: string, leadBotId: string | null): TeamMemberModel | null => {
    const bot = botsById.get(botId);
    if (bot === undefined) return null;
    return {
      botId,
      name: bot.name,
      avatarShape: bot.avatarShape,
      avatarColor: bot.avatarColor,
      modelLabel: input.modelLabelOf(bot),
      isLead: leadBotId === botId,
      live: input.liveBotIds.has(botId),
    };
  };
  return buildTeamGroups(input.bots, input.customTeams).map((group) => {
    const ids = [...(group.leadBotId === null ? [] : [group.leadBotId]), ...group.memberBotIds];
    const members = ids.flatMap((id) => {
      const row = member(id, group.leadBotId);
      return row === null ? [] : [row];
    });
    return {
      team: group.team,
      label: group.label,
      total: members.length,
      members,
      custom: input.customTeams.some((custom) => sameTeam(custom, group.team)),
      removable: group.leadBotId === null && group.memberBotIds.length === 0,
    };
  });
}

/** The line over the cards: "2 teams · 5 bots · tap a bot to move it". */
export function teamSummary(teamCount: number, botCount: number): string {
  return `${String(teamCount)} ${teamCount === 1 ? "team" : "teams"} · ${String(botCount)} ${
    botCount === 1 ? "bot" : "bots"
  } · tap a bot to move it`;
}

/** "Remove team" only when the team is empty; the server refuses otherwise. */
export function removeTeamLabel(removable: boolean): string {
  return removable ? "Remove team" : "Remove team (move its bots first)";
}

export type TeamScreenState =
  | { readonly kind: "offline" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" }
  | { readonly kind: "ready" };

export function teamScreenState(input: {
  readonly connected: boolean;
  readonly listLoaded: boolean;
  readonly listError: string | null;
  readonly botCount: number;
  readonly teamCount: number;
}): TeamScreenState {
  if (!input.connected) return { kind: "offline" };
  if (!input.listLoaded) {
    return input.listError === null
      ? { kind: "loading" }
      : { kind: "error", message: input.listError };
  }
  if (input.botCount === 0 && input.teamCount === 0) return { kind: "empty" };
  return { kind: "ready" };
}

/** A bot that has a live thread in the bot list is working. */
export function liveBotIds(
  threads: ReadonlyArray<{ readonly threadId: string; readonly botId: string }>,
  shells: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlySet<string> {
  const liveThreadIds = new Set(
    shells.filter((shell) => isThreadLive(shell)).map((shell) => shell.id as string),
  );
  return new Set(
    threads.filter((thread) => liveThreadIds.has(thread.threadId)).map((thread) => thread.botId),
  );
}

/** The bot at one end of a running handoff, as the row draws it. */
export interface WorkingNowBot {
  readonly botId: string;
  readonly name: string;
  readonly avatarShape: PersonalBot["avatarShape"];
  readonly avatarColor: string;
}

/** One row of the Team screen's "Working now" list. */
export interface WorkingNowRow {
  readonly taskId: string;
  readonly from: WorkingNowBot;
  readonly to: WorkingNowBot;
  readonly title: string;
  /** The receiving bot's task chat, or null while the task has no chat yet. */
  readonly threadId: string | null;
  readonly forLabel: string;
}

/**
 * The handoffs running now, named for the screen's bots. A bot the chart does
 * not draw is left out, as on the web, so a row never points at a page the
 * Team screen cannot open.
 */
export function teamWorkingNowRows(input: {
  readonly tasks: ReadonlyArray<PersonalTask>;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly nowMs: number;
}): ReadonlyArray<WorkingNowRow> {
  const botsById = new Map(input.bots.map((bot) => [bot.botId as string, bot] as const));
  const listed = new Set(botsById.keys());
  return deriveWorkingNow(input.tasks, listed).flatMap((item) => {
    const from = botsById.get(item.from);
    const to = botsById.get(item.to);
    if (from === undefined || to === undefined) return [];
    const bot = (entry: PersonalBot): WorkingNowBot => ({
      botId: entry.botId as string,
      name: entry.name,
      avatarShape: entry.avatarShape,
      avatarColor: entry.avatarColor,
    });
    return [
      {
        taskId: item.taskId,
        from: bot(from),
        to: bot(to),
        title: item.title,
        threadId: item.threadId,
        forLabel: formatWorkingFor(item.sinceMs, input.nowMs),
      },
    ];
  });
}

/** What the token card shows for one range, computed from the server's scan. */
export interface TeamUsageModel {
  readonly table: TokenUsageTable | null;
  /** `25 Oct` or `19–25 Oct`, when a table exists. */
  readonly span: string | null;
  /** `Updated 4m ago`, or null while there is no snapshot. */
  readonly updated: string | null;
  /** `in 4.2M · cached 110.0M (96%) · out 1.2M`, or null while there is no window. */
  readonly split: string | null;
  readonly periodWord: "today" | "in this period";
  /** The server is still counting, so the card may ask again soon. */
  readonly pending: boolean;
}

export function teamUsageModel(input: {
  readonly result: PersonalBotTokenUsageResult | null;
  readonly windowId: PersonalBotTokenUsageWindowId;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly listedBotIds: ReadonlySet<string>;
  readonly modelNames: ReadonlyMap<string, string>;
  readonly nowMs: number;
}): TeamUsageModel {
  const selected = findTokenUsageWindow(input.result, input.windowId);
  return {
    table:
      selected === null
        ? null
        : buildTokenUsageTable({
            window: selected,
            bots: input.bots.map((bot) => ({ botId: bot.botId as string, name: bot.name })),
            listedBotIds: input.listedBotIds,
            modelNames: input.modelNames,
          }),
    span: selected === null ? null : formatWindowSpan(selected.sinceDay, selected.untilDay),
    updated: formatUpdated(input.result?.readAt ?? null, input.nowMs),
    split: selected === null ? null : formatSplit(splitOf(selected.total.totals)),
    periodWord: input.windowId === "today" ? "today" : "in this period",
    pending: isTokenUsagePending(input.result?.status),
  };
}

export interface MoveSheetOption {
  readonly team: PersonalBotTeam;
  readonly label: string;
  readonly kind: "team" | "lead";
  readonly title: string;
  readonly detail: string;
  readonly disabled: boolean;
  readonly replaces: LeadReplacement | null;
}

/**
 * The move sheet: one Join and one Lead option per team, each carrying the
 * sentence the shared drop rules already produce. A lead seat that would
 * replace someone opens the confirm sheet instead of moving at once.
 */
export function moveSheetOptions(
  bot: TeamDropBot,
  groups: ReadonlyArray<TeamGroup>,
  roster: ReadonlyArray<TeamDropBot>,
): ReadonlyArray<MoveSheetOption> {
  const rows: ReadonlyArray<MoveTargetRow> = teamMoveTargets(bot, groups, roster);
  return rows.flatMap((row) => [
    {
      team: row.team,
      label: row.label,
      kind: "team" as const,
      title: row.here ? `Stay on ${row.label}` : `Move to ${row.label}`,
      detail: row.join.message,
      disabled: row.join.kind === "none" || row.join.kind === "blocked",
      replaces: null,
    },
    {
      team: row.team,
      label: row.label,
      kind: "lead" as const,
      title: `Lead of ${row.label}`,
      detail: row.lead.message,
      disabled: row.lead.kind !== "update",
      replaces: row.replaces,
    },
  ]);
}

/** The confirm sheet copy for taking a lead seat, or null when nobody is replaced. */
export function leadConfirmFor(
  bot: TeamDropBot,
  team: PersonalBotTeam,
  roster: ReadonlyArray<TeamDropBot>,
): LeadConfirmCopy | null {
  const replaced = replacedLead(bot, team, roster);
  return replaced === null ? null : leadConfirmCopy({ bot, team, replaced });
}

/** The move to send for one option, or the sentence that says why not. */
export function moveForOption(
  bot: TeamDropBot,
  option: MoveSheetOption,
  roster: ReadonlyArray<TeamDropBot>,
) {
  return teamDropOutcome(bot, { kind: option.kind, team: option.team }, roster);
}

export interface NewTeamPlan {
  readonly nameError: string | null;
  readonly warning: string | null;
  readonly moves: ReadonlyArray<TeamMove>;
  readonly createdMessage: string | null;
}

/** What the Team screen says the moment a team has been made. */
export interface TeamNotice {
  readonly team: string;
  readonly message: string;
}

/** What the New team form will do, derived before anything is sent. */
export function newTeamPlan(input: {
  readonly name: string;
  readonly leader: PersonalBot | null;
  readonly members: ReadonlyArray<PersonalBot>;
  readonly customTeams: ReadonlyArray<PersonalBotTeam>;
  readonly allBots: ReadonlyArray<PersonalBot>;
}): NewTeamPlan {
  const name = input.name.trim();
  const moving = [...(input.leader === null ? [] : [input.leader]), ...input.members];
  const leaving = leadersLeaving(moving);
  return {
    nameError: teamNameProblem(input.name, input.customTeams, input.allBots),
    warning: leaving.length === 0 ? null : leaderMoveWarning(leaving, name),
    moves: planTeamMoves({ leader: input.leader, members: input.members, team: name }),
    createdMessage:
      leaving.length === 0
        ? teamCreatedMessage({
            team: name,
            leaderName: input.leader?.name ?? null,
            memberCount: input.members.length,
          })
        : null,
  };
}

/** The New team button's words, so the form and its tests agree. */
export function newTeamButtonLabel(input: {
  readonly busy: boolean;
  readonly createdName: string | null;
  readonly leaderName: string | null;
}): string {
  if (input.busy) return "Creating…";
  if (input.createdName !== null) return "Try again";
  return input.leaderName === null ? "Create team" : `Create team, ${input.leaderName} leads`;
}

/** The leader picker: "No leader for now" first, then every bot. */
export interface LeaderChoice {
  readonly botId: string | null;
  readonly name: string;
  readonly detail: string | null;
  readonly leads: string | null;
}

export function leaderChoices(
  bots: ReadonlyArray<PersonalBot>,
  modelLabelOf: (bot: PersonalBot) => string | null,
): ReadonlyArray<LeaderChoice> {
  return [
    { botId: null, name: "No leader for now", detail: null, leads: null },
    ...bots.map((bot) => ({
      botId: bot.botId as string,
      name: bot.name,
      detail: modelLabelOf(bot),
      leads: isTeamLead(bot) ? `Leads ${personalBotTeamLabel(botTeam(bot))}` : null,
    })),
  ];
}

export type RemovedBotsState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" }
  | { readonly kind: "ready" };

export function removedBotsState(input: {
  readonly loaded: boolean;
  readonly error: string | null;
  readonly rowCount: number;
}): RemovedBotsState {
  if (input.error !== null) return { kind: "error", message: input.error };
  if (!input.loaded) return { kind: "loading" };
  if (input.rowCount === 0) return { kind: "empty" };
  return { kind: "ready" };
}

export interface RemovedBotRow {
  readonly bot: PersonalRemovedBot;
  readonly subtitle: string;
  readonly removedBy: string;
  readonly chats: string;
  readonly note: string | null;
}

/**
 * Rows render from every removed bot seen plus the current list, so a restored
 * bot keeps a row long enough to say it worked.
 */
export function removedBotRows(input: {
  readonly seen: ReadonlyArray<PersonalRemovedBot>;
  readonly current: ReadonlyArray<PersonalRemovedBot>;
  readonly restored: Readonly<Record<string, string>>;
  readonly nowMs: number;
}): ReadonlyArray<RemovedBotRow> {
  const merged = mergeSeenRemovedBots(input.seen, input.current);
  const currentById = new Map(input.current.map((bot) => [bot.botId as string, bot] as const));
  return merged.flatMap((bot) => {
    const id = bot.botId as string;
    const note = input.restored[id] ?? null;
    if (note === null && !currentById.has(id)) return [];
    const latest = currentById.get(id) ?? bot;
    return [
      {
        bot: latest,
        subtitle: removedBotSubtitle(latest),
        removedBy: removedByLine(latest, input.nowMs),
        chats: `${String(latest.chats)} ${latest.chats === 1 ? "chat" : "chats"} kept`,
        note,
      },
    ];
  });
}

/** What a successful restore says, from the server's result. */
export function restoredRowNote(result: Parameters<typeof restoredMessage>[0]): string {
  return restoredMessage(result);
}

/**
 * Handed from the New team screen to the Team screen in memory and taken
 * exactly once, so a Back or a reload does not announce it again.
 */
let pendingNotice: TeamNotice | null = null;

export function setTeamNotice(notice: TeamNotice): void {
  pendingNotice = notice;
}

export function takeTeamNotice(): TeamNotice | null {
  const notice = pendingNotice;
  pendingNotice = null;
  return notice;
}
