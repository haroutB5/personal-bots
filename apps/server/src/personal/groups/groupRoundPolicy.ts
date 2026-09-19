import type { PersonalBotId } from "@t3tools/contracts";

/**
 * The loop protection of a group round, as pure functions over the round's own
 * queue and speaker history. The philosophy is the delegation limiter's
 * (design §2.5); the mechanism is different because a group is a flat ring
 * rather than a tree, so there is no ancestry to walk.
 */

/** How many recent speakers the ping-pong detector looks at. */
export const PING_PONG_WINDOW = 4;

/**
 * True when the last four speakers are A, B, A, B: two members are answering
 * each other and nobody else is joining. The round ends rather than spending
 * the rest of its budget on the same two bots.
 */
export const isPingPong = (spoken: ReadonlyArray<PersonalBotId>): boolean => {
  if (spoken.length < PING_PONG_WINDOW) {
    return false;
  }
  const [first, second, third, fourth] = spoken.slice(-PING_PONG_WINDOW);
  return first !== second && first === third && second === fourth;
};

export interface AdmitMentionsInput {
  /** The member whose reply produced `mentioned`. */
  readonly speaker: PersonalBotId;
  /** Mentions parsed from that reply, in order (see `groupMentions.ts`). */
  readonly mentioned: ReadonlyArray<PersonalBotId>;
  /** Members already waiting to speak in this round. */
  readonly queue: ReadonlyArray<PersonalBotId>;
  /** Members that have already spoken in this round, including repeats. */
  readonly spoken: ReadonlyArray<PersonalBotId>;
  /** Members of the group right now; a mention of anything else is inert. */
  readonly members: ReadonlyArray<PersonalBotId>;
  readonly maxTurnsPerMember: number;
}

const occurrences = (list: ReadonlyArray<PersonalBotId>, botId: PersonalBotId) =>
  list.reduce((total, entry) => (entry === botId ? total + 1 : total), 0);

/**
 * The mentions that actually earn a turn, in mention order.
 *
 * Dropped: the speaker mentioning itself (a bot writing "as @Me said" must not
 * buy itself another turn), anyone who is not a member, and anyone whose turns
 * already spoken plus turns already queued have reached the per-member cap.
 * The cap counts what is planned, not just what has happened, so two replies
 * naming the same member in one round cannot queue it twice over the cap.
 */
export const admitMentions = (input: AdmitMentionsInput): ReadonlyArray<PersonalBotId> => {
  const admitted: Array<PersonalBotId> = [];
  for (const botId of input.mentioned) {
    if (botId === input.speaker) {
      continue;
    }
    if (!input.members.includes(botId)) {
      continue;
    }
    const planned =
      occurrences(input.spoken, botId) +
      occurrences(input.queue, botId) +
      occurrences(admitted, botId);
    if (planned >= input.maxTurnsPerMember) {
      continue;
    }
    admitted.push(botId);
  }
  return admitted;
};

export interface RoundLimits {
  readonly queue: ReadonlyArray<PersonalBotId>;
  readonly spoken: ReadonlyArray<PersonalBotId>;
  readonly budgetRemaining: number;
  readonly nowMs: number;
  readonly deadlineMs: number;
}

export type RoundVerdict =
  | { readonly kind: "speak"; readonly botId: PersonalBotId }
  | { readonly kind: "completed" }
  | { readonly kind: "ping-pong" }
  | { readonly kind: "paused_budget" }
  | { readonly kind: "expired" };

/**
 * What the round should do next, given only its own state. Ordering matters:
 * an empty queue completes even if the budget is spent, and the wall clock
 * beats everything so a round can never outlive its ten minutes.
 */
export const nextStep = (limits: RoundLimits): RoundVerdict => {
  if (limits.nowMs >= limits.deadlineMs) {
    return { kind: "expired" };
  }
  if (limits.queue.length === 0) {
    return { kind: "completed" };
  }
  if (isPingPong(limits.spoken)) {
    return { kind: "ping-pong" };
  }
  if (limits.budgetRemaining <= 0) {
    return { kind: "paused_budget" };
  }
  return { kind: "speak", botId: limits.queue[0]! };
};
