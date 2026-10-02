import { type PersonalMemoryCard, personalBotTeamLabel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * A bot's change to memory other bots see, as a card in the chat it happened
 * in. Nothing applies until the owner taps Save (or Forget); the tap is bound
 * to `changeHash`, so the bot cannot swap what it asked for.
 */
export type MemoryCardItem = {
  readonly changeId: number;
  readonly createdAtMs: number;
  readonly pending: boolean;
  readonly card: PersonalMemoryCard;
};

/** The cards for one chat, oldest first. */
export function deriveMemoryCards(
  cards: ReadonlyArray<PersonalMemoryCard>,
  threadId: string,
): ReadonlyArray<MemoryCardItem> {
  return cards
    .filter((card) => card.threadId === threadId)
    .map((card) => ({
      changeId: card.changeId,
      createdAtMs: DateTime.toEpochMillis(card.createdAt),
      pending: card.status === "pending",
      card,
    }))
    .toSorted(
      (left, right) => left.createdAtMs - right.createdAtMs || left.changeId - right.changeId,
    );
}

/** "CTO", from `bot:<id>`; "A bot" when it is not listed. */
export function memoryCardBotName(
  proposedBy: string | null,
  botName: (botId: string) => string | undefined,
): string {
  if (proposedBy?.startsWith("bot:")) return botName(proposedBy.slice(4)) ?? "A bot";
  return "A bot";
}

/** "All bots" / "Dev team" / "Only CTO" (a save just for the bot that asked) for a card's reach. */
export function memoryCardReach(
  scope: string | null,
  scopeId: string | null,
  who: string = "this bot",
): string {
  if (scope === "bot") return `Only ${who}`;
  if (scope === "team") {
    const team = scopeId?.trim();
    return team ? personalBotTeamLabel(team) : "one team";
  }
  return "All bots";
}

/**
 * "CTO wants to save a preference for Dev team" / "CTO wants to save a note
 * for itself" (only CTO will see it) / "CTO asks to forget".
 */
export function memoryCardHeadline(
  card: Pick<PersonalMemoryCard, "action" | "proposedBy" | "kind" | "scope" | "scopeId">,
  botName: (botId: string) => string | undefined,
): string {
  const who = memoryCardBotName(card.proposedBy, botName);
  if (card.action === "forget") return `${who} asks to forget`;
  const kind = card.kind === "preference" ? "preference" : "note";
  const reach = card.scope === "bot" ? "itself" : memoryCardReach(card.scope, card.scopeId, who);
  return `${who} wants to save a ${kind} for ${reach}`;
}

/** Who will see it, under the card: a save just for its bot says so. */
export function memoryCardAudienceNote(
  card: Pick<PersonalMemoryCard, "action" | "proposedBy" | "scope">,
  botName: (botId: string) => string | undefined,
): string {
  if (card.action === "save" && card.scope === "bot") {
    const who = memoryCardBotName(card.proposedBy, botName);
    return `${memoryCardReach("bot", null, who)} will see this memory, and only you can approve it.`;
  }
  return "Other bots see this memory, so only you can approve it.";
}

/** The two buttons: approve first, then the refusal. */
export function memoryCardButtons(action: PersonalMemoryCard["action"]): {
  readonly approve: string;
  readonly reject: string;
} {
  return action === "forget"
    ? { approve: "Forget", reject: "Keep it" }
    : { approve: "Save", reject: "Don't save" };
}

/**
 * A decided card's one line: "Saved" / "Not saved" / "Forgotten" / "Kept".
 * Null while it still waits for the owner.
 */
export function memoryCardSettledLine(
  card: Pick<PersonalMemoryCard, "action" | "status">,
): string | null {
  if (card.status === "pending") return null;
  const done = card.status === "approved" || card.status === "applied";
  if (card.action === "forget") return done ? "Forgotten" : "Kept";
  return done ? "Saved" : "Not saved";
}
