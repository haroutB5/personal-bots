import {
  botTeam,
  isBotOnTeam,
  isTeamLead,
  personalBotTeamLabel,
  personalBotTeams,
  sameTeam,
  type PersonalBot,
  type PersonalBotTeam,
} from "@t3tools/contracts";

export const TEAM_NAME_MAX = 60;

/**
 * Why a new team's name can't be used, or null. The server files a second
 * "research" under "Research" without a word and only refuses the built-ins,
 * so the form says it first: the same case-insensitive match the server uses
 * (`setProfile`, `requireKnownTeam`), read against the registered teams, the
 * built-ins by key and by label ("Dev team"), and any team a bot is already
 * stored on, so a name never lands on a band the diagram already draws.
 */
export function teamNameProblem(
  name: string,
  customTeams: ReadonlyArray<PersonalBotTeam>,
  bots: ReadonlyArray<Pick<PersonalBot, "team">>,
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Give the team a name.";
  if (trimmed.length > TEAM_NAME_MAX) {
    return `Team names are at most ${String(TEAM_NAME_MAX)} characters.`;
  }
  const key = trimmed.toLowerCase();
  const known = personalBotTeams([...customTeams, ...bots.map(botTeam)]);
  const clash = known.find(
    (team) => sameTeam(team, trimmed) || personalBotTeamLabel(team).toLowerCase() === key,
  );
  if (clash === undefined) return null;
  return `There is already a team called ${personalBotTeamLabel(clash)}.`;
}

/** What moving the chosen leader takes from another team, or null when nothing. */
export interface LeaderMove {
  readonly botName: string;
  readonly fromTeam: PersonalBotTeam;
}

/**
 * The bots among `moving` that lead a team today. Moving one leaves its old
 * team without a lead (there is one lead per team and nobody steps up), which
 * the owner has to agree to first.
 */
export function leadersLeaving(
  moving: ReadonlyArray<Pick<PersonalBot, "name" | "team" | "lead">>,
): ReadonlyArray<LeaderMove> {
  return moving.filter(isTeamLead).map((bot) => ({ botName: bot.name, fromTeam: botTeam(bot) }));
}

/** "CTO leads Dev team; it will move to Research, and Dev team will have no lead." */
export function leaderMoveWarning(moves: ReadonlyArray<LeaderMove>, newTeam: string): string {
  const name = newTeam.trim() === "" ? "the new team" : newTeam.trim();
  return moves
    .map((move) => {
      const from = personalBotTeamLabel(move.fromTeam);
      return `${move.botName} leads ${from}; it will move to ${name}, and ${from} will have no lead.`;
    })
    .join(" ");
}

/** One bot update the form sends after the team exists: the same fields the bot form sends. */
export interface TeamMove {
  readonly botId: PersonalBot["botId"];
  readonly name: string;
  readonly lead: boolean;
}

/**
 * The leader first, then the members. A member that led another team is set
 * to `lead: false` on the way in: the server only clears a team's lead when
 * the incoming bot claims it, so a lead carried across unchanged would
 * become a second lead of the new team.
 */
export function planTeamMoves(input: {
  readonly leader: PersonalBot | null;
  readonly members: ReadonlyArray<PersonalBot>;
  readonly team: PersonalBotTeam;
}): ReadonlyArray<TeamMove> {
  const { leader, members, team } = input;
  return [
    ...(leader === null ? [] : [{ botId: leader.botId, name: leader.name, lead: true }]),
    ...members
      .filter((bot) => leader === null || bot.botId !== leader.botId)
      .filter((bot) => !isBotOnTeam(bot, team))
      .map((bot) => ({ botId: bot.botId, name: bot.name, lead: false })),
  ];
}

/** What the diagram announces once the team exists. */
export function teamCreatedMessage(input: {
  readonly team: string;
  readonly leaderName: string | null;
  readonly memberCount: number;
}): string {
  const { team, leaderName, memberCount } = input;
  const lead = leaderName === null ? "It has no lead yet." : `${leaderName} leads it.`;
  const members =
    memberCount === 0
      ? ""
      : ` ${String(memberCount)} ${memberCount === 1 ? "bot moved" : "bots moved"} in.`;
  return `Team ${team} created. ${lead}${members}`;
}
