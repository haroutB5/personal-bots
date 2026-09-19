import type { PersonalBotId } from "@t3tools/contracts";

/**
 * The pure half of group voting: what counts as the same question, and who
 * won. Nothing here reads a database or decides to act - a tally is a reading
 * of ballots, and acting on it is always the owner's Approve (design §V.3).
 */

/**
 * Filler a re-ask can change freely without changing the question. Dropping
 * these is what makes the re-ask rail bite on a *reworded* question rather
 * than only on an identical string (§V.2).
 */
const STOP_WORDS = new Set([
  "a",
  "actually",
  "all",
  "an",
  "and",
  "any",
  "are",
  "be",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "here",
  "i",
  "in",
  "is",
  "it",
  "just",
  "maybe",
  "me",
  "my",
  "now",
  "of",
  "on",
  "one",
  "or",
  "our",
  "please",
  "really",
  "shall",
  "should",
  "so",
  "that",
  "the",
  "then",
  "think",
  "this",
  "to",
  "us",
  "we",
  "what",
  "will",
  "would",
  "you",
  "your",
]);

const tokensOf = (question: string): ReadonlyArray<string> =>
  question
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);

/**
 * The key a question is remembered by inside one round. Case, punctuation,
 * accents, filler words and word ORDER are all flattened, so "Should we ship
 * on Friday?" and "Friday - do we ship?" are the same question and the second
 * ask is refused.
 *
 * Deliberately fails closed: a question whose every word is filler keeps its
 * filler (otherwise two different such questions would both key on ""), and a
 * near-miss collides rather than opening a second vote, because the cost of a
 * refused re-ask is a sentence and the cost of a re-run vote is the round.
 */
export const normaliseQuestion = (question: string): string => {
  const tokens = tokensOf(question);
  const content = tokens.filter((token) => !STOP_WORDS.has(token));
  const kept = content.length > 0 ? content : tokens;
  return [...new Set(kept)].sort().join(" ");
};

export interface VoteBallotLike {
  readonly botId: PersonalBotId;
  readonly option: string;
}

export interface VoteTally {
  /** Every option in the order it was offered, with the ballots it drew. */
  readonly counts: ReadonlyArray<{ readonly option: string; readonly votes: number }>;
  /** The single option with the strictly highest count, else null. */
  readonly winningOption: string | null;
  /** True when no option won outright: an exact tie, or nobody voted. */
  readonly tied: boolean;
  /** Eligible members that never balloted. */
  readonly abstentions: number;
}

/**
 * Plurality: the option with the most ballots wins. An exact tie at the top
 * resolves with NO winner, and so does a vote nobody answered - there is no
 * tie-break, because inventing one would let a coin toss decide what the bots
 * do next.
 *
 * Ballots for an option that is not on the ballot paper are ignored, and a
 * ballot from a bot that is no longer eligible is ignored too.
 */
export const tallyVote = (input: {
  readonly options: ReadonlyArray<string>;
  readonly ballots: ReadonlyArray<VoteBallotLike>;
  readonly eligible: ReadonlyArray<PersonalBotId>;
}): VoteTally => {
  const counted = input.ballots.filter(
    (ballot) => input.eligible.includes(ballot.botId) && input.options.includes(ballot.option),
  );
  const counts = input.options.map((option) => ({
    option,
    votes: counted.filter((ballot) => ballot.option === option).length,
  }));
  const top = counts.reduce((max, entry) => Math.max(max, entry.votes), 0);
  const leaders = counts.filter((entry) => entry.votes === top);
  const winningOption = top > 0 && leaders.length === 1 ? leaders[0]!.option : null;
  const voted = new Set(counted.map((ballot) => ballot.botId));
  return {
    counts,
    winningOption,
    tied: winningOption === null,
    abstentions: input.eligible.filter((botId) => !voted.has(botId)).length,
  };
};
