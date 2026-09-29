import * as NodeCrypto from "node:crypto";

/**
 * Pure parts of the lead-bot confirm card: how long a request lives, what a tap is
 * bound to, which messages count as the owner speaking, and the words the lead is
 * told. The service (`PersonalLeadBotService`) does the reading and writing.
 */

/** How long the owner has to answer a card before it cancels itself. */
export const LEAD_BOT_CONFIRM_WINDOW_MS = 15 * 60 * 1000;
/** Settled requests stay listed (so their card keeps its ending) this long. */
export const LEAD_BOT_CONFIRM_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** How often the server looks for cards past their window. */
export const LEAD_BOT_CONFIRM_SWEEP_MS = 30 * 1000;

/** Server-written user-role turn message telling a lead how the owner answered. */
export const PERSONAL_LEAD_ANSWER_MESSAGE_ID_PREFIX = "personal-lead-answer-";

/**
 * Whether a user-role message is the owner speaking. Every message the server
 * writes itself carries a `personal-` id (task briefs and steers, routine runs,
 * usage-limit continues, group rounds, the answers to confirm cards), while the
 * owner's own messages carry the client's ids. Fail-closed: a new server-written
 * prefix is not the owner without anyone having to remember to list it.
 */
export const isOwnerMessageId = (messageId: string): boolean => !messageId.startsWith("personal-");

/** JSON with object keys sorted at every level, so equal values give equal text. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
};

/**
 * What a tap on Yes is bound to: the target bot, the action and the exact new
 * values (an update's patch, or a removal's reason). Any other change, however
 * similar, has another hash, and a stored row whose values were altered no
 * longer matches the hash the card showed.
 */
export const leadBotChangeHash = (input: {
  readonly botId: string;
  readonly action: "update" | "remove";
  readonly values: unknown;
}): string =>
  NodeCrypto.createHash("sha256")
    .update(canonicalJson({ botId: input.botId, action: input.action, values: input.values }))
    .digest("hex");

export type LeadBotAnswer =
  | { readonly kind: "approved"; readonly what: string }
  | { readonly kind: "declined"; readonly what: string }
  | { readonly kind: "expired"; readonly what: string }
  | { readonly kind: "failed"; readonly what: string; readonly why: string };

/** The turn message a lead gets when its request is answered. Server text; the owner sees a system row. */
export const leadBotAnswerText = (answer: LeadBotAnswer): string => {
  switch (answer.kind) {
    case "approved":
      return `[Team change answered] Harout approved your request: ${answer.what}. It has been done. Do not repeat it; carry on with what you were doing.`;
    case "declined":
      return `[Team change answered] Harout declined your request: ${answer.what}. Nothing was changed. Do not retry it or work around it; tell him briefly what you were trying to do and ask what he wants instead.`;
    case "expired":
      return `[Team change answered] Your request was never answered and has timed out: ${answer.what}. Nothing was changed. Ask Harout whether he still wants it before requesting it again.`;
    case "failed":
      return `[Team change answered] Harout approved your request (${answer.what}) but it could not be carried out: ${answer.why}. Nothing was changed. Tell him and ask what he wants to do.`;
  }
};

/** The line shown in the lead's chat for an answer that changed nothing. */
export const leadBotAnswerLine = (
  leadName: string,
  answer: Exclude<LeadBotAnswer, { kind: "approved" }>,
): string => {
  switch (answer.kind) {
    case "declined":
      return `You declined ${leadName}'s request: ${answer.what}. Nothing was changed.`;
    case "expired":
      return `${leadName}'s request timed out without an answer: ${answer.what}. Nothing was changed.`;
    case "failed":
      return `${leadName}'s request was approved but not applied (${answer.why}): ${answer.what}.`;
  }
};
