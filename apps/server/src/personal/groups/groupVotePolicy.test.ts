import { describe, expect, it } from "@effect/vitest";

import { PersonalBotId } from "@t3tools/contracts";

import { normaliseQuestion, tallyVote } from "./groupVotePolicy.ts";

const A = PersonalBotId.make("bot-a");
const B = PersonalBotId.make("bot-b");
const C = PersonalBotId.make("bot-c");

const ballot = (botId: PersonalBotId, option: string) => ({ botId, option });

describe("normaliseQuestion", () => {
  it("ignores case, punctuation, accents and spacing", () => {
    const key = normaliseQuestion("Should we ship on Friday?");
    expect(normaliseQuestion("SHOULD WE SHIP ON FRIDAY!!!")).toBe(key);
    expect(normaliseQuestion("  should   we  ship  on  friday  ")).toBe(key);
    expect(normaliseQuestion("Should wé ship on Fridáy?")).toBe(key);
  });

  it("ignores filler words and word order, so a reworded re-ask matches", () => {
    // This is the rail of section V.2: a losing side must not get a second
    // vote by asking the same thing in different words.
    const key = normaliseQuestion("Should we ship on Friday?");
    expect(normaliseQuestion("Friday - do we ship?")).toBe(key);
    expect(normaliseQuestion("I think we really should just ship Friday.")).toBe(key);
  });

  it("does not claim to catch a re-ask that brings a new word with it", () => {
    // The key is the set of content words, so padding the question with a word
    // that carries meaning makes a different key. Recorded rather than hidden:
    // this rail stops nagging, and the rail that stops a decision ACTING is
    // the owner's approval, which no rewording can get past.
    expect(normaliseQuestion("Should we ship on Friday?")).not.toBe(
      normaliseQuestion("Should we ship on Friday, honestly?"),
    );
  });

  it("still tells two different questions apart", () => {
    expect(normaliseQuestion("Should we ship on Friday?")).not.toBe(
      normaliseQuestion("Should we delay to Monday?"),
    );
    expect(normaliseQuestion("Do we use Postgres?")).not.toBe(
      normaliseQuestion("Do we use SQLite?"),
    );
  });

  it("keeps the filler when a question is nothing but filler", () => {
    // Dropping every token would key two unrelated questions on "" and refuse
    // the second one for no reason.
    expect(normaliseQuestion("Should we?")).not.toBe(normaliseQuestion("Do you think so?"));
    expect(normaliseQuestion("Should we?")).not.toBe("");
  });
});

describe("tallyVote", () => {
  const options = ["ship", "wait"];

  it("gives the plurality winner", () => {
    const tally = tallyVote({
      options,
      ballots: [ballot(A, "ship"), ballot(B, "ship"), ballot(C, "wait")],
      eligible: [A, B, C],
    });
    expect(tally.winningOption).toBe("ship");
    expect(tally.tied).toBe(false);
    expect(tally.abstentions).toBe(0);
    expect(tally.counts).toEqual([
      { option: "ship", votes: 2 },
      { option: "wait", votes: 1 },
    ]);
  });

  it("wins on a plurality, not a majority", () => {
    const tally = tallyVote({
      options: ["a", "b", "c"],
      ballots: [ballot(A, "a"), ballot(B, "b"), ballot(C, "c")],
      eligible: [A, B, C],
    });
    // Three ways, one each: nothing leads, so nothing wins.
    expect(tally.winningOption).toBe(null);

    const plurality = tallyVote({
      options: ["a", "b", "c"],
      ballots: [ballot(A, "a"), ballot(B, "b"), ballot(C, "b")],
      eligible: [A, B, C],
    });
    expect(plurality.winningOption).toBe("b");
  });

  it("resolves an exact tie with no winner, and never breaks it", () => {
    const tally = tallyVote({
      options,
      ballots: [ballot(A, "ship"), ballot(B, "wait")],
      eligible: [A, B],
    });
    expect(tally.winningOption).toBe(null);
    expect(tally.tied).toBe(true);
  });

  it("counts members that never balloted as abstentions", () => {
    const tally = tallyVote({
      options,
      ballots: [ballot(A, "ship")],
      eligible: [A, B, C],
    });
    expect(tally.winningOption).toBe("ship");
    expect(tally.abstentions).toBe(2);
  });

  it("gives a vote nobody answered no winner at all", () => {
    const tally = tallyVote({ options, ballots: [], eligible: [A, B] });
    expect(tally.winningOption).toBe(null);
    expect(tally.tied).toBe(true);
    expect(tally.abstentions).toBe(2);
  });

  it("ignores a ballot for an option that is not on the paper", () => {
    const tally = tallyVote({
      options,
      ballots: [ballot(A, "ship"), ballot(B, "something else")],
      eligible: [A, B],
    });
    expect(tally.winningOption).toBe("ship");
    // B's ballot did not count, so B abstained.
    expect(tally.abstentions).toBe(1);
  });

  it("ignores a ballot from a bot that is no longer a member", () => {
    const tally = tallyVote({
      options,
      ballots: [ballot(A, "ship"), ballot(C, "wait"), ballot(B, "wait")],
      eligible: [A, B],
    });
    // C left the group between voting and the tally, so its ballot is dropped
    // and "wait" has one vote, not two.
    expect(tally.counts).toEqual([
      { option: "ship", votes: 1 },
      { option: "wait", votes: 1 },
    ]);
    expect(tally.winningOption).toBe(null);
  });
});
