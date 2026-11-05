import {
  botTeam,
  isBotOnTeam,
  isTeamLead,
  personalBotTeamLabel,
  personalBotTeams,
  sameTeam,
  PERSONAL_TASK_TERMINAL_STATUSES,
  type PersonalBotTeam,
  type PersonalTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** One team as the diagram draws it: its lead, then everyone else. */
export interface TeamGroup {
  readonly team: PersonalBotTeam;
  readonly label: string;
  readonly leadBotId: string | null;
  readonly memberBotIds: ReadonlyArray<string>;
}

export type DelegationLinkState = "running" | "recent";

export interface DelegationLink {
  readonly from: string;
  readonly to: string;
  readonly state: DelegationLinkState;
}

export const RECENT_DELEGATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * How many bots are on a team, read the way the server reads it. Manage teams
 * offers Remove only at zero, and the server refuses a removal while any bot
 * is on the team, so both sides have to compare team names case-insensitively
 * or the button appears for a team that still has members.
 */
export function countTeamMembers(
  bots: ReadonlyArray<{ readonly team?: PersonalBotTeam }>,
  team: PersonalBotTeam,
): number {
  return bots.filter((bot) => isBotOnTeam(bot, team)).length;
}

/**
 * One entry per team, under the spelling that team is registered with.
 *
 * `personalBotTeams` lists the built-in IDs first, then whatever it is handed;
 * hand it the registered custom teams before the bots' own stored strings and
 * the first survivor of each case-insensitive group is, in order of
 * preference, the built-in ID, the profile's spelling, or — for a team nobody
 * registered — the first spelling a bot was stored with. Rows written before
 * `requireKnownTeam` started writing the registered spelling back (v1.21.4)
 * can still say "RESEARCH" where the profile says "Research"; they belong in
 * the one band, drawn under "Research". Nothing here rewrites a stored string.
 */
function registeredTeamSpellings(
  customTeams: ReadonlyArray<PersonalBotTeam>,
  botTeams: ReadonlyArray<PersonalBotTeam>,
): ReadonlyArray<PersonalBotTeam> {
  const ordered = personalBotTeams([...customTeams, ...botTeams]);
  return ordered.filter(
    (team, index) => ordered.findIndex((earlier) => sameTeam(earlier, team)) === index,
  );
}

/**
 * Groups bots under their leads. Registered custom teams remain available
 * as drop targets when empty.
 */
export function buildTeamGroups(
  bots: ReadonlyArray<{
    readonly botId: string;
    readonly team?: PersonalBotTeam;
    readonly lead?: boolean;
  }>,
  customTeams: ReadonlyArray<PersonalBotTeam> = [],
): TeamGroup[] {
  return registeredTeamSpellings(customTeams, bots.map(botTeam)).flatMap((team) => {
    const members = bots.filter((bot) => isBotOnTeam(bot, team));
    if (members.length === 0 && !customTeams.some((custom) => sameTeam(custom, team))) return [];
    const lead = members.find(isTeamLead) ?? null;
    return [
      {
        team,
        label: personalBotTeamLabel(team),
        leadBotId: lead?.botId ?? null,
        memberBotIds: members.filter((bot) => bot.botId !== lead?.botId).map((bot) => bot.botId),
      },
    ];
  });
}

/**
 * Turns task parent/child relationships into directed bot links. An unfinished
 * child wins over recent history for the same pair.
 */
export function deriveDelegationLinks(
  tasks: ReadonlyArray<PersonalTask>,
  botIds: ReadonlySet<string>,
  nowMs: number,
): DelegationLink[] {
  const tasksById = new Map(tasks.map((task) => [task.taskId as string, task] as const));
  const links = new Map<string, DelegationLink>();
  const recentCutoff = nowMs - RECENT_DELEGATION_WINDOW_MS;

  for (const child of tasks) {
    if (child.parentTaskId === null) continue;
    const parent = tasksById.get(child.parentTaskId as string);
    if (parent === undefined) continue;
    const from = parent.botId as string;
    const to = child.botId as string;
    if (from === to || !botIds.has(from) || !botIds.has(to)) continue;

    const terminal = PERSONAL_TASK_TERMINAL_STATUSES.includes(child.status);
    const completedMs = DateTime.toEpochMillis(child.completedAt ?? child.updatedAt);
    const state: DelegationLinkState | null = terminal
      ? completedMs >= recentCutoff
        ? "recent"
        : null
      : "running";
    if (state === null) continue;

    const key = `${from}\u0000${to}`;
    const previous = links.get(key);
    if (previous === undefined || (previous.state === "recent" && state === "running")) {
      links.set(key, { from, to, state });
    }
  }

  return [...links.values()].toSorted(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

/**
 * What a drop means. `team` is "join this team as a member" (the team's card);
 * `lead` is "take this team's lead seat", which also moves the bot to that team.
 */
export interface TeamDropTarget {
  readonly kind: "team" | "lead";
  readonly team: PersonalBotTeam;
}

/** A place a lifted bot can land: the id is the drop card's `data-drop-zone`. */
export interface TeamDropZone {
  readonly id: string;
  readonly target: TeamDropTarget;
}

/** The zone id of one drop target, shared by the cards and the hit test. */
export function teamDropZoneId(target: TeamDropTarget): string {
  return `${target.kind}:${target.team}`;
}

/** The last drop card: start a new team with the bot in it. */
export const NEW_TEAM_ZONE_ID = "new-team";

/**
 * What a drop would do. `update` is exactly the `personalBots.update` patch to
 * send; `lead: true` makes the server demote the team's previous lead in the
 * same write, so the diagram can never show two Lead badges.
 */
export type TeamDropOutcome =
  | { readonly kind: "none"; readonly message: string }
  | { readonly kind: "blocked"; readonly message: string }
  | {
      readonly kind: "update";
      readonly message: string;
      readonly update: { readonly team: PersonalBotTeam; readonly lead: boolean };
    };

export interface TeamDropBot {
  readonly botId: string;
  readonly name: string;
  readonly team?: PersonalBotTeam;
  readonly lead?: boolean;
}

/**
 * A team is never left with members but no lead, so a lead can only move out
 * once somebody else has the seat. Moving the last bot off a team is fine: the
 * team simply stops being drawn.
 */
export function teamDropOutcome(
  bot: TeamDropBot,
  target: TeamDropTarget,
  roster: ReadonlyArray<TeamDropBot>,
): TeamDropOutcome {
  const from = botTeam(bot);
  const to = target.team;
  const toLabel = personalBotTeamLabel(to);
  // Case-insensitively: a bot stored as "RESEARCH" dropped on the "Research"
  // band has not left its team, so this reports "already on" rather than
  // announcing a move and writing the row for the sake of its spelling.
  const leaving = !sameTeam(from, to);

  if (leaving && isTeamLead(bot)) {
    const staying = roster.filter((other) => other.botId !== bot.botId && isBotOnTeam(other, from));
    if (staying.length > 0) {
      return {
        kind: "blocked",
        message: `${bot.name} leads the ${personalBotTeamLabel(from)}. Make someone else the lead there first, then move ${bot.name}.`,
      };
    }
  }

  if (target.kind === "lead") {
    if (!leaving && isTeamLead(bot)) {
      return { kind: "none", message: `${bot.name} already leads the ${toLabel}.` };
    }
    return {
      kind: "update",
      message: `${bot.name} now leads the ${toLabel}.`,
      update: { team: to, lead: true },
    };
  }

  if (!leaving) {
    return {
      kind: "none",
      message: isTeamLead(bot)
        ? `${bot.name} already leads the ${toLabel}.`
        : `${bot.name} is already on the ${toLabel}.`,
    };
  }
  return {
    kind: "update",
    message: `${bot.name} moved to the ${toLabel}.`,
    update: { team: to, lead: false },
  };
}

/** What the live region says while a bot hangs over a target, or over nothing. */
export function teamDropHint(
  bot: TeamDropBot,
  zone: TeamDropZone | null,
  roster: ReadonlyArray<TeamDropBot>,
): string {
  if (zone === null) return `${bot.name} is over nothing. Let go to keep it where it is.`;
  const outcome = teamDropOutcome(bot, zone.target, roster);
  if (outcome.kind === "update") {
    const label = personalBotTeamLabel(zone.target.team);
    return outcome.update.lead
      ? `Let go to make ${bot.name} the ${label} lead.`
      : `Let go to move ${bot.name} to the ${label}.`;
  }
  return outcome.message;
}
