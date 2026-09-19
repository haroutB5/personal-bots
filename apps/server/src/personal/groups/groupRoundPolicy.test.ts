import { describe, expect, it } from "@effect/vitest";

import { PersonalBotId } from "@t3tools/contracts";

import { admitMentions, isPingPong, nextStep } from "./groupRoundPolicy.ts";

const bot = (key: string) => PersonalBotId.make(`bot-${key}`);
const A = bot("a");
const B = bot("b");
const C = bot("c");
const MEMBERS = [A, B, C];

const admit = (input: {
  speaker: PersonalBotId;
  mentioned: ReadonlyArray<PersonalBotId>;
  queue?: ReadonlyArray<PersonalBotId>;
  spoken?: ReadonlyArray<PersonalBotId>;
  members?: ReadonlyArray<PersonalBotId>;
}) =>
  admitMentions({
    speaker: input.speaker,
    mentioned: input.mentioned,
    queue: input.queue ?? [],
    spoken: input.spoken ?? [],
    members: input.members ?? MEMBERS,
    maxTurnsPerMember: 2,
  });

describe("admitMentions", () => {
  it("ignores a self-mention", () => {
    expect(admit({ speaker: A, mentioned: [A, B] })).toEqual([B]);
  });

  it("ignores a mention of someone who is not a member", () => {
    expect(admit({ speaker: A, mentioned: [bot("stranger"), B] })).toEqual([B]);
  });

  it("stops a member at two turns per round, counting spoken and queued", () => {
    expect(admit({ speaker: A, mentioned: [B], spoken: [B, B] })).toEqual([]);
    expect(admit({ speaker: A, mentioned: [B], spoken: [B], queue: [B] })).toEqual([]);
    expect(admit({ speaker: A, mentioned: [B], spoken: [B] })).toEqual([B]);
  });

  it("counts what it is admitting, so one reply cannot queue a member twice over", () => {
    // Without counting `admitted`, "@B and @B" would put B in the queue twice
    // even though it had already spoken once.
    expect(admit({ speaker: A, mentioned: [B, B, B], spoken: [B] })).toEqual([B]);
  });

  it("keeps mention order", () => {
    expect(admit({ speaker: A, mentioned: [C, B] })).toEqual([C, B]);
  });
});

describe("isPingPong", () => {
  it("fires on A, B, A, B and not on anything shorter", () => {
    expect(isPingPong([A, B, A, B])).toBe(true);
    expect(isPingPong([C, A, B, A, B])).toBe(true);
    expect(isPingPong([A, B, A])).toBe(false);
  });

  it("does not fire when a third member joined in", () => {
    expect(isPingPong([A, B, C, B])).toBe(false);
    expect(isPingPong([A, A, A, A])).toBe(false);
  });
});

describe("nextStep", () => {
  const base = { queue: [A], spoken: [], budgetRemaining: 3, nowMs: 0, deadlineMs: 1_000 };

  it("speaks the head of the queue", () => {
    expect(nextStep(base)).toEqual({ kind: "speak", botId: A });
  });

  it("completes on an empty queue even with budget left", () => {
    expect(nextStep({ ...base, queue: [] })).toEqual({ kind: "completed" });
  });

  it("pauses when the budget is out but someone is still queued", () => {
    expect(nextStep({ ...base, budgetRemaining: 0 })).toEqual({ kind: "paused_budget" });
  });

  it("ends a ping-pong before spending more budget on it", () => {
    expect(nextStep({ ...base, spoken: [A, B, A, B] })).toEqual({ kind: "ping-pong" });
  });

  it("lets the wall clock beat every other verdict", () => {
    // Including the ones that would otherwise be terminal anyway: a round can
    // never outlive its ten minutes, whatever else is true of it.
    expect(nextStep({ ...base, nowMs: 1_000 })).toEqual({ kind: "expired" });
    expect(nextStep({ ...base, queue: [], nowMs: 2_000 })).toEqual({ kind: "expired" });
  });
});
