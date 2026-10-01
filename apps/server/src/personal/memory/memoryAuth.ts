/**
 * When a bot's memory write is the owner's own decision. A shared or team
 * save, replace or forget applies at once only when the turn was started by
 * the owner's own message, that message asks for it, the saved text is
 * supported by it, and any entry it replaces or forgets is named in it.
 * Anything short of that becomes a proposal on the owner's approval list.
 * Page, tool and file content never counts: only the owner's message does.
 */
import { subjectWords } from "./memoryTidy.ts";

/** The owner asks to keep something. */
export const SAVE_INTENT =
  /\b(remember|memori[sz]e|don'?t forget|do not forget|keep in mind|save (this|that|it)|note (this|that|it)( down)?|for future reference|from now on|going forward|always|never|make (it|this) a rule|new rule)\b/i;

/** The owner asks to drop something. */
export const FORGET_INTENT =
  /\b(forget|stop remembering|don'?t remember|remove (it|that|this|the)|delete (it|that|this|the)|drop (it|that|this|the)|no longer|not true any ?more|out of date|outdated|stop doing)\b/i;

const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();

/** The quote is word for word part of the message (case, spacing and punctuation aside). */
export function quoteInMessage(quote: string, message: string): boolean {
  const needle = normalise(quote);
  return needle.length > 0 && ` ${normalise(message)} `.includes(` ${needle} `);
}

/** Bookkeeping words a bot adds around a fact; they say nothing about its subject. */
const FILLER = new Set(
  "rule rules preference preferences note notes update updated saved save remember standing instruction instructions set confirmed restated wants want said says asked".split(
    " ",
  ),
);

const stem = (word: string) => (word.length > 4 ? word.replace(/(ies|es|s|ing|ed)$/, "") : word);

const meaningful = (text: string) =>
  new Set([...subjectWords(text)].filter((word) => !FILLER.has(word)).map(stem));

/** At least this share of the saved text's subject words must come from the owner's message. */
export const CONTENT_SUPPORT_SHARE = 0.6;

/** The saved text says what the owner's message says, not something else. */
export function contentSupported(content: string, message: string): boolean {
  const said = meaningful(message);
  const saved = [...meaningful(content)];
  if (saved.length === 0) return false;
  return saved.filter((word) => said.has(word)).length / saved.length >= CONTENT_SUPPORT_SHARE;
}

/**
 * The owner's message names this entry: its id, or enough of its subject
 * (two of its words, or one when the entry has at most two).
 */
export function targetNamed(
  target: { readonly memoryId: string; readonly content: string },
  message: string,
): boolean {
  if (message.toLowerCase().includes(target.memoryId.slice(0, 8).toLowerCase())) return true;
  const words = [...meaningful(target.content)];
  const said = meaningful(message);
  const shared = words.filter((word) => said.has(word)).length;
  return shared >= 2 || (words.length <= 2 && shared >= 1);
}
