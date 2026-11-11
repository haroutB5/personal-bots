import { botTeam, isTeamLead } from "@t3tools/contracts";

/**
 * The bot the Quick Settings tile and the launcher shortcut open a new chat
 * with: the CTO, which is the Dev team's lead. The alias stands in for the bot
 * id where the id is not known (the static shortcut, or a tile before the app
 * has published it); the app resolves it when the link opens.
 */
export const CTO_ALIAS = "cto";

interface CtoCandidate {
  readonly botId: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly team?: string;
  readonly lead?: boolean;
}

/** The link that opens a new chat with a bot, or with the CTO when no id is given. */
export function newChatLink(botId: string = CTO_ALIAS): string {
  return `hbots://bot/${encodeURIComponent(botId)}?new=1`;
}

/**
 * The CTO bot: the enabled lead of the Dev team, else an enabled bot named
 * "CTO". Null when the user has neither, which is the no-CTO case.
 */
export function findCtoBot<T extends CtoCandidate>(bots: ReadonlyArray<T>): T | null {
  const live = bots.filter((bot) => bot.enabled !== false);
  const lead = live.find((bot) => isTeamLead(bot) && botTeam(bot as never) === "dev");
  if (lead !== undefined) return lead;
  return live.find((bot) => bot.name.trim().toLowerCase() === CTO_ALIAS) ?? null;
}

/** What the app tells the tile: the exact link, or null to fall back to the alias. */
export function ctoTileLink(bots: ReadonlyArray<CtoCandidate>): string | null {
  const cto = findCtoBot(bots);
  return cto === null ? null : newChatLink(cto.botId);
}

export type NewChatTarget =
  | { readonly kind: "bot"; readonly botId: string }
  | { readonly kind: "no-cto" }
  | { readonly kind: "missing" };

/** Resolves the bot id from a new-chat link: the alias means the CTO. */
export function resolveNewChatTarget(
  botId: string,
  bots: ReadonlyArray<CtoCandidate>,
): NewChatTarget {
  if (botId === CTO_ALIAS) {
    const cto = findCtoBot(bots);
    return cto === null ? { kind: "no-cto" } : { kind: "bot", botId: cto.botId };
  }
  return bots.some((bot) => bot.botId === botId && bot.enabled !== false)
    ? { kind: "bot", botId }
    : { kind: "missing" };
}
