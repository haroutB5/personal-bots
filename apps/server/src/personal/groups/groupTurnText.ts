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
 */
export const buildCatchUpBrief = (input: GroupCatchUpInput): string => {
  const others =
    input.otherNames.length === 0
      ? "You are the only member."
      : `The other members are: ${input.otherNames.map((name) => `@${name}`).join(", ")}.`;
  return [
    `[Group chat: ${input.groupName}]`,
    `You are ${input.speakerName} in this group. ${others}`,
    "Reply once, as yourself, to the conversation below. To ask another member to reply next, mention them by name with an @ (for example @Name). Do not answer on anyone else's behalf.",
    "Conversation so far:",
    buildCatchUpTranscript({ messages: input.messages, maxChars: input.maxChars }),
  ].join("\n\n");
};
