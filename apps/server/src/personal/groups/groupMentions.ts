import type { PersonalBotId } from "@t3tools/contracts";

/**
 * Mention routing for group chats. Pure on purpose: routing decides who spends
 * a provider turn, so it is the one part of the round loop that has to be
 * testable without a database, a provider or a clock.
 *
 * Mentions are parsed from the reply TEXT rather than from a tool call, so the
 * same routing works on every provider and needs no adherence to a new tool
 * (design §2.3).
 */

export interface GroupMentionCandidate {
  readonly botId: PersonalBotId;
  /** The member's display name as it is at parse time. */
  readonly name: string;
}

/** `@all` and `@everyone` address every other member, in sort order. */
export const ALL_MENTION_ALIASES = ["all", "everyone"] as const;

/** A name ends where a word character, apostrophe or hyphen stops. */
const isNameBoundary = (character: string | undefined) =>
  character === undefined || !/[\w'-]/.test(character);

/**
 * Blanks inline code spans, keeping the line's length so every index into the
 * masked text still points at the same character of the original.
 */
const maskInlineCode = (line: string): string => {
  const characters = line.split("");
  let index = 0;
  while (index < characters.length) {
    if (characters[index] !== "`") {
      index += 1;
      continue;
    }
    let run = 0;
    while (index + run < characters.length && characters[index + run] === "`") {
      run += 1;
    }
    const marker = "`".repeat(run);
    const closing = line.indexOf(marker, index + run);
    if (closing === -1) {
      // An unclosed span is not code; leave the rest of the line alone.
      index += run;
      continue;
    }
    for (let position = index; position < closing + run; position += 1) {
      characters[position] = " ";
    }
    index = closing + run;
  }
  return characters.join("");
};

/**
 * Replaces fenced blocks and inline code spans with spaces of the same length.
 *
 * This is a cost rail, not cosmetics: a bot that pastes a snippet containing
 * `@Planner` would otherwise buy Planner a provider turn (design §2.5).
 */
export const maskCode = (text: string): string => {
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const opener = /^[ \t]*(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        if (
          opener !== null &&
          opener[1]!.startsWith(fence[0]!) &&
          opener[1]!.length >= fence.length
        ) {
          fence = null;
        }
        return " ".repeat(line.length);
      }
      if (opener !== null) {
        fence = opener[1]!;
        return " ".repeat(line.length);
      }
      return maskInlineCode(line);
    })
    .join("\n");
};

/**
 * The members `text` addresses, in the order they are first mentioned and
 * de-duplicated. Longest name wins at each `@`, so "@Tech Lead" is not read as
 * "@Tech". Matching is case-insensitive; an `@` that follows a word character
 * (an email address) is not a mention.
 *
 * Self-mentions are NOT filtered here - that is the round policy's job, which
 * knows who is speaking (see `groupRoundPolicy.ts`).
 */
export const parseMentions = (
  text: string,
  candidates: ReadonlyArray<GroupMentionCandidate>,
): ReadonlyArray<PersonalBotId> => {
  const masked = maskCode(text);
  const byLongestName = [...candidates]
    .filter((candidate) => candidate.name.trim().length > 0)
    .toSorted((left, right) => right.name.length - left.name.length);
  const found: Array<PersonalBotId> = [];
  const remember = (botId: PersonalBotId) => {
    if (!found.includes(botId)) {
      found.push(botId);
    }
  };
  let index = 0;
  while (index < masked.length) {
    if (masked[index] !== "@") {
      index += 1;
      continue;
    }
    const preceding = index === 0 ? undefined : masked[index - 1];
    if (preceding !== undefined && /[\w@]/.test(preceding)) {
      index += 1;
      continue;
    }
    const rest = masked.slice(index + 1);
    const lowered = rest.toLowerCase();
    const alias = ALL_MENTION_ALIASES.find(
      (candidate) => lowered.startsWith(candidate) && isNameBoundary(rest[candidate.length]),
    );
    if (alias !== undefined) {
      for (const candidate of candidates) {
        remember(candidate.botId);
      }
      index += alias.length + 1;
      continue;
    }
    const match = byLongestName.find(
      (candidate) =>
        lowered.startsWith(candidate.name.toLowerCase()) &&
        isNameBoundary(rest[candidate.name.length]),
    );
    if (match === undefined) {
      index += 1;
      continue;
    }
    remember(match.botId);
    index += match.name.length + 1;
  }
  return found;
};
