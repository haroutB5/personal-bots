import {
  botTeam,
  isBotOnTeam,
  isTeamLead,
  personalBotTeamLabel,
  sameTeam,
  type PersonalBotTeam,
} from "@t3tools/contracts";

import {
  teamDropOutcome,
  type TeamDropBot,
  type TeamDropOutcome,
  type TeamDropTarget,
  type TeamGroup,
} from "./teamDiagramModel.ts";

/* Moving a bot between teams is the same decision on the phone and on the web. */

export interface LeadReplacement {
  readonly oldLeadId: string;
  readonly oldLeadName: string;
  /** Handoffs the old lead has open; they carry on. */
  readonly openHandoffs: number;
}

/** The lead a Lead drop would replace, or null when the seat is empty or already the bot's. */
export function replacedLead(
  bot: TeamDropBot,
  team: PersonalBotTeam,
  roster: ReadonlyArray<TeamDropBot>,
  openHandoffsBy: (botId: string) => number = () => 0,
): LeadReplacement | null {
  const current = roster.find(
    (other) => other.botId !== bot.botId && isBotOnTeam(other, team) && isTeamLead(other),
  );
  if (current === undefined) return null;
  return {
    oldLeadId: current.botId,
    oldLeadName: current.name,
    openHandoffs: openHandoffsBy(current.botId),
  };
}

export interface LeadConfirmCopy {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  readonly confirmLabel: string;
}

/** The action sheet for taking over a team's lead seat. */
export function leadConfirmCopy(input: {
  readonly bot: TeamDropBot;
  readonly team: PersonalBotTeam;
  readonly replaced: LeadReplacement;
}): LeadConfirmCopy {
  const { bot, team, replaced } = input;
  const teamLabel = personalBotTeamLabel(team);
  const lines = [`${replaced.oldLeadName} stops leading and stays on the ${teamLabel}.`];
  if (replaced.openHandoffs > 0) {
    lines.push(
      `${replaced.oldLeadName} has ${String(replaced.openHandoffs)} ${
        replaced.openHandoffs === 1 ? "handoff" : "handoffs"
      } running; ${replaced.openHandoffs === 1 ? "it carries" : "they carry"} on.`,
    );
  }
  // The bot leaves a team whose only member it is: that team is left empty.
  if (isTeamLead(bot) && !sameTeam(botTeam(bot), team)) {
    const from = personalBotTeamLabel(botTeam(bot));
    lines.push(
      `${bot.name} leads ${from}; it will move to ${teamLabel}, and ${from} will have no lead.`,
    );
  }
  return {
    title: `Make ${bot.name} the ${teamLabel} lead?`,
    lines,
    confirmLabel: `Make ${bot.name} lead`,
  };
}

export interface MoveTargetRow {
  readonly team: PersonalBotTeam;
  readonly label: string;
  /** Members including the lead, not counting the bot being moved. */
  readonly memberCount: number;
  readonly leadName: string | null;
  readonly leadBotId: string | null;
  /** The bot's own team: nothing to join. */
  readonly here: boolean;
  readonly join: TeamDropOutcome;
  readonly lead: TeamDropOutcome;
  /** Set when the Lead drop would replace someone: ask first. */
  readonly replaces: LeadReplacement | null;
}

/**
 * One row per team for the move sheet: what joining it and taking its lead
 * seat would do, so the sheet never re-derives the rules the move itself uses.
 */
export function teamMoveTargets(
  bot: TeamDropBot,
  groups: ReadonlyArray<TeamGroup>,
  roster: ReadonlyArray<TeamDropBot>,
  openHandoffsBy?: (botId: string) => number,
): MoveTargetRow[] {
  const names = new Map(roster.map((entry) => [entry.botId, entry.name] as const));
  return groups.map((group) => {
    const others = roster.filter(
      (entry) => entry.botId !== bot.botId && isBotOnTeam(entry, group.team),
    );
    const outcomeFor = (kind: "team" | "lead") =>
      teamDropOutcome(bot, { kind, team: group.team }, roster);
    const lead = outcomeFor("lead");
    return {
      team: group.team,
      label: group.label,
      memberCount: others.length,
      leadName: group.leadBotId === null ? null : (names.get(group.leadBotId) ?? null),
      leadBotId: group.leadBotId,
      here: sameTeam(botTeam(bot), group.team),
      join: outcomeFor("team"),
      lead,
      replaces:
        lead.kind === "update" ? replacedLead(bot, group.team, roster, openHandoffsBy) : null,
    };
  });
}

/**
 * A move as the server applies it, so the screen can show it at once: the bot
 * takes its new team and role, and taking a lead seat hands it over in the same
 * write, so nobody ever shows two Lead badges.
 */
export function applyTeamUpdate<
  T extends { readonly botId: string; readonly team?: PersonalBotTeam; readonly lead?: boolean },
>(
  roster: ReadonlyArray<T>,
  update: { readonly botId: string; readonly team: PersonalBotTeam; readonly lead: boolean },
): T[] {
  return roster.map((bot) => {
    if (bot.botId === update.botId) return { ...bot, team: update.team, lead: update.lead };
    if (update.lead && isBotOnTeam(bot, update.team)) return { ...bot, lead: false };
    return bot;
  });
}

export type DropPlan =
  | { readonly kind: "none"; readonly message: string }
  | { readonly kind: "blocked"; readonly message: string }
  /** A Lead drop that replaces someone: ask first, send nothing yet. */
  | {
      readonly kind: "confirm";
      readonly outcome: Extract<TeamDropOutcome, { kind: "update" }>;
      readonly replaced: LeadReplacement;
    }
  | {
      readonly kind: "commit";
      readonly outcome: Extract<TeamDropOutcome, { kind: "update" }>;
      readonly replaced: LeadReplacement | null;
    };

/**
 * What a move (or a tap on a team in the move sheet) does. Moving a bot is sent
 * at once, except taking over a team's lead seat from somebody: that asks
 * first, because it changes who delegates for the whole team, unless it was
 * already confirmed.
 */
export function planDrop(input: {
  readonly bot: TeamDropBot;
  readonly target: TeamDropTarget;
  readonly roster: ReadonlyArray<TeamDropBot>;
  readonly openHandoffsBy?: (botId: string) => number;
  readonly confirmed?: boolean;
}): DropPlan {
  const outcome = teamDropOutcome(input.bot, input.target, input.roster);
  if (outcome.kind !== "update") return outcome;
  const replaced =
    input.target.kind === "lead"
      ? replacedLead(input.bot, input.target.team, input.roster, input.openHandoffsBy)
      : null;
  if (replaced !== null && input.confirmed !== true) return { kind: "confirm", outcome, replaced };
  return { kind: "commit", outcome, replaced };
}

/** One `personalBots.update` the Undo sends. */
export interface UndoStep {
  readonly botId: string;
  readonly team: PersonalBotTeam;
  readonly lead: boolean;
}

/**
 * How to put a move back. When the move took a lead seat, the old lead gets it
 * back first; then the bot returns to its old team and role. The server hands a
 * seat over in the same write, so nobody is ever left with two Lead badges.
 */
export function undoPlan(input: {
  readonly before: {
    readonly botId: string;
    readonly team: PersonalBotTeam;
    readonly lead: boolean;
  };
  readonly replaced: LeadReplacement | null;
  readonly destination: PersonalBotTeam;
}): UndoStep[] {
  const steps: UndoStep[] = [];
  if (input.replaced !== null) {
    steps.push({ botId: input.replaced.oldLeadId, team: input.destination, lead: true });
  }
  steps.push({ botId: input.before.botId, team: input.before.team, lead: input.before.lead });
  return steps;
}

/** What the live region says once an Undo has gone through. */
export function undoMessage(botName: string, team: PersonalBotTeam, lead: boolean): string {
  const label = personalBotTeamLabel(team);
  return lead ? `${botName} is back as the ${label} lead.` : `${botName} is back on the ${label}.`;
}
