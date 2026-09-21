/**
 * The text a speaking member is handed. Pure so the catch-up cap can be tested
 * without a database: this string is the whole cost of the chosen relay design
 * (§1.3), since every member's session accumulates it.
 */

export interface GroupCatchUpMessage {
  /** "You" for the owner, the bot's name for a member, "System" otherwise. */
  readonly speaker: string;
  readonly text: string;
}

export interface GroupCatchUpInput {
  readonly phase?: "discussion" | "verdict";
  readonly userRequest?: string;
  readonly groupName: string;
  /** The member about to speak, so the brief can name it. */
  readonly speakerName: string;
  /** Everyone else, in sort order; the mention vocabulary of this group. */
  readonly otherNames: ReadonlyArray<string>;
  /** Messages the member has not seen, oldest first. */
  readonly messages: ReadonlyArray<GroupCatchUpMessage>;
  readonly maxChars: number;
}

const omittedNotice = (count: number) =>
  `[… ${count} earlier message${count === 1 ? "" : "s"} omitted]`;

const render = (message: GroupCatchUpMessage) => `${message.speaker}: ${message.text}`;

/**
 * The transcript slice, newest-biased: lines are kept from the end until
 * `maxChars` is reached and the rest collapse to one notice. A single message
 * longer than the whole budget is tail-truncated rather than dropped, so the
 * member always sees what it was just asked.
 */
export const buildCatchUpTranscript = (input: {
  readonly messages: ReadonlyArray<GroupCatchUpMessage>;
  readonly maxChars: number;
}): string => {
  if (input.messages.length === 0) {
    return "";
  }
  const kept: Array<string> = [];
  let used = 0;
  let index = input.messages.length - 1;
  while (index >= 0) {
    const line = render(input.messages[index]!);
    if (used + line.length > input.maxChars && kept.length > 0) {
      break;
    }
    if (used + line.length > input.maxChars) {
      // The newest message alone overflows: keep its tail, never nothing.
      kept.unshift(`[… truncated]${line.slice(line.length - input.maxChars)}`);
      index -= 1;
      break;
    }
    kept.unshift(line);
    used += line.length + 1;
    index -= 1;
  }
  const omitted = index + 1;
  return (omitted > 0 ? [omittedNotice(omitted), ...kept] : kept).join("\n\n");
};

/**
 * The full user-role brief relayed into a member's own thread. It names the
 * group, the speaker and the other members, because a member's provider sees
 * only its own thread and has no other way to learn the mention vocabulary.
 *
 * Only the mention-driven phase invites @mentions, because it is the only
 * phase whose replies are parsed for them: a discussion round queues every
 * member up front and drops mentions, and the verdict is a single turn. A
 * brief that asked for something the rails refuse would be teaching the bot to
 * spend a turn on a request that can never land.
 */
export const buildCatchUpBrief = (input: GroupCatchUpInput): string => {
  const others =
    input.otherNames.length === 0
      ? "You are the only member."
      : `The other members are: ${input.otherNames.map((name) => `@${name}`).join(", ")}.`;
  return [
    `[Group chat: ${input.groupName}]`,
    `You are ${input.speakerName} in this group. ${others}`,
    input.phase === "verdict"
      ? 'Deliver the group\'s ONE final verdict to the user. Synthesize the contributions below into a single useful answer. Speak for the whole group in the first person plural ("we", "our pick", "we found"), never as yourself ("I", "my pick"): you are the group\'s voice here, not one member giving a personal opinion. Name a member only to credit a specific finding or a dissent ("<name> found...", "<name> disagrees because..."). Resolve disagreements using evidence; explicitly retain unresolved disagreements and unknowns. Do not claim unanimous agreement without evidence. Verify important claims and product variants, stock and delivered totals when relevant. Include source links, not provider citation tokens. Do not list repetitive answers per bot, request more bot replies, or use @mentions. Lead with the result and keep the explanation concise.'
      : input.phase === "discussion"
        ? "Contribute concise research notes for the group's final verdict. Address the user's request, check evidence, and add new findings or challenge specific errors in prior contributions. Do not repeat settled points or write another final answer to the user. If you have nothing new, say so briefly. Include source URLs and uncertainties. Every member is already scheduled to contribute, so do not use @mentions to ask for another member's turn: in this phase they buy nobody a turn. A designated member will synthesize everyone's notes into one final verdict."
        : "Reply once, as yourself, to the conversation below. Consider the other members' replies and avoid repeating settled points. To request a follow-up from a particular member, mention them with @Name. Do not answer on anyone else's behalf.",
    ...(input.userRequest ? [`User request:\n${input.userRequest}`] : []),
    "Conversation so far:",
    buildCatchUpTranscript({ messages: input.messages, maxChars: input.maxChars }),
  ].join("\n\n");
};
