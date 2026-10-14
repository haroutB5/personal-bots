/*
 * The `chat_needs_input` notification: a plain bot chat has parked on the user
 * - a question, a tool approval, a sign-in or a secret - and nothing else is
 * going to say so. Task and routine chats keep their own `task_needs_input`
 * (see PersonalPushService.notifyTask), and the four request kinds below are
 * the only things this kind covers.
 *
 * Pure functions only: the wording and the caps are unit-tested here; the
 * service does the lookups and builds the payload (chatReplyPushPayload and
 * friends live there, with `chatPath`).
 */

/** One request a chat is waiting on. */
export type ChatNeedsInputKind = "question" | "approval" | "sign-in" | "secret";

/** The body prefix each kind opens with, as the lock screen shows it. */
export const CHAT_NEEDS_INPUT_LABEL: Record<ChatNeedsInputKind, string> = {
  question: "Needs your answer",
  approval: "Needs approval",
  "sign-in": "Needs a sign-in",
  secret: "Needs a secret",
};

/** How much of the request itself fits in a notification body. */
export const CHAT_NEEDS_INPUT_DETAIL_MAX = 140;
/** "Juno · Weekend in Lisbon" is short by design; a long chat title is cut. */
export const CHAT_NEEDS_INPUT_TITLE_MAX = 60;

/** Markdown marks and runs of whitespace folded away: one clean line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One line, capped with an ellipsis. "" stays "". */
export function cappedLine(text: string, max: number): string {
  const line = oneLine(text);
  if (line.length === 0) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The body: "Needs your answer: Which table?" - the label alone when there is no detail. */
export function chatNeedsInputBody(kind: ChatNeedsInputKind, detail: string): string {
  const label = CHAT_NEEDS_INPUT_LABEL[kind];
  const line = cappedLine(detail, CHAT_NEEDS_INPUT_DETAIL_MAX);
  return line.length === 0 ? label : `${label}: ${line}`;
}

/**
 * The first question of a `user-input.requested` activity, one line: what the
 * notification asks, without the option list an answer card carries.
 */
export function firstQuestionText(questions: unknown): string {
  if (!Array.isArray(questions)) return "";
  for (const entry of questions) {
    const question =
      typeof entry === "object" && entry !== null && "question" in entry
        ? (entry as { question?: unknown }).question
        : undefined;
    if (typeof question === "string" && oneLine(question).length > 0) return question;
  }
  return "";
}

/**
 * What an `approval.requested` activity is about: the command or description
 * the provider gave, else the app it named, else nothing - the body then
 * reads "Needs approval" alone, never the activity's own summary ("Command
 * approval requested"), which repeats the kind without saying what it is.
 */
export function approvalDetail(payload: {
  readonly detail?: unknown;
  readonly appName?: unknown;
}): string {
  for (const candidate of [payload.detail, payload.appName]) {
    if (typeof candidate === "string" && oneLine(candidate).length > 0) return candidate;
  }
  return "";
}

/** "Juno · Weekend in Lisbon": the bot, then the chat. */
export function chatNeedsInputTitle(botName: string, chatTitle: string): string {
  const chat = cappedLine(chatTitle, CHAT_NEEDS_INPUT_TITLE_MAX);
  return chat.length === 0 ? botName : `${botName} · ${chat}`;
}
