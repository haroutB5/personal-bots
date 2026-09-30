import type { MessageId, OrchestrationMessage } from "@t3tools/contracts";

/**
 * The chat so far, for a turn that starts a fresh provider session in a chat
 * that already has messages: the bot moved to another provider, or the
 * provider no longer has the conversation it would resume. The new session
 * knows nothing of the chat, so the turn carries its recent messages in front
 * of the owner's message, the same slot as the bot's memory (turn context).
 *
 * Newest messages win when the budget is short; each is capped so one long
 * reply cannot crowd out the rest. Returns undefined when there is nothing
 * earlier to carry, or no room for it.
 */
export const HANDOFF_MAX_CHARS = 24_000;
const HANDOFF_MESSAGE_MAX_CHARS = 2_000;
const HANDOFF_MIN_USEFUL_CHARS = 400;

const HANDOFF_HEADER =
  "Earlier in this chat (carried over from a previous session that could not be continued; the owner can see all of it, so do not repeat it back):";
const HANDOFF_FOOTER = "End of earlier messages. The owner's new message follows.";

type HandoffMessage = Pick<OrchestrationMessage, "id" | "role" | "text" | "attachments">;

function attachmentNote(message: HandoffMessage): string {
  const names = (message.attachments ?? []).map((attachment) =>
    "name" in attachment && typeof attachment.name === "string" && attachment.name.length > 0
      ? attachment.name
      : attachment.type,
  );
  return names.length > 0 ? ` [attached: ${names.join(", ")}]` : "";
}

function renderMessage(message: HandoffMessage): string | undefined {
  const speaker =
    message.role === "user" ? "Owner" : message.role === "assistant" ? "You" : undefined;
  if (speaker === undefined) return undefined;
  const text = message.text.trim();
  const note = attachmentNote(message);
  if (text.length === 0 && note.length === 0) return undefined;
  const clipped =
    text.length > HANDOFF_MESSAGE_MAX_CHARS
      ? `${text.slice(0, HANDOFF_MESSAGE_MAX_CHARS)}… (cut)`
      : text;
  return `${speaker}: ${clipped}${note}`;
}

export function buildChatHandoff(input: {
  readonly messages: ReadonlyArray<HandoffMessage>;
  /** The message this turn sends; it is not "earlier". */
  readonly currentMessageId?: MessageId | undefined;
  readonly maxChars?: number;
}): string | undefined {
  const budget = Math.min(input.maxChars ?? HANDOFF_MAX_CHARS, HANDOFF_MAX_CHARS);
  const frame = HANDOFF_HEADER.length + HANDOFF_FOOTER.length + 2;
  if (budget - frame < HANDOFF_MIN_USEFUL_CHARS) return undefined;
  let remaining = budget - frame;
  const lines: Array<string> = [];
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    if (input.currentMessageId !== undefined && message.id === input.currentMessageId) continue;
    const line = renderMessage(message);
    if (line === undefined) continue;
    if (line.length + 1 > remaining) break;
    lines.push(line);
    remaining -= line.length + 1;
  }
  if (lines.length === 0) return undefined;
  return [HANDOFF_HEADER, ...lines.reverse(), HANDOFF_FOOTER].join("\n");
}
