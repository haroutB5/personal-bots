/**
 * A bot's trailing `choices` fence, parsed once for every surface that offers
 * its options as buttons: the chat, the widget and the Work tab. Malformed
 * blocks stay code.
 */

export const CHOICES_FENCE = "```choices";
export const CHOICES_MIN = 2;
export const CHOICES_MAX = 6;
/** Longer than this is a paragraph, not a button label. */
export const CHOICE_MAX_CHARS = 120;

export interface ChoicesSplit {
  /** The reply without the block (and without a half-written one while it streams). */
  readonly body: string;
  readonly options: ReadonlyArray<string> | null;
}

/** A closing fence: ``` alone on its line. */
const CLOSING_FENCE = /(?:^|\n)```[ \t]*(?=\n|$)/;

/** A leading bullet or number a bot added although it was asked not to. */
const LIST_MARKER = /^(?:[-*•]|\d{1,2}[.)])\s+/;

function parseOptions(block: string): ReadonlyArray<string> | null {
  const options: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const option = line.trim().replace(LIST_MARKER, "").trim();
    if (option.length === 0) continue;
    if (option.length > CHOICE_MAX_CHARS) return null;
    if (!options.includes(option)) options.push(option);
  }
  return options.length >= CHOICES_MIN && options.length <= CHOICES_MAX ? options : null;
}

/** Splits a reply into its text and trailing choices; a streaming block is held back. */
export function splitChoices(text: string, streaming = false): ChoicesSplit {
  const start = text.lastIndexOf(CHOICES_FENCE);
  if (start === -1) return { body: text, options: null };
  // The fence must open its own line.
  if (start > 0 && text[start - 1] !== "\n") return { body: text, options: null };
  const afterTag = text.indexOf("\n", start);
  if (afterTag === -1) {
    return { body: streaming ? text.slice(0, start).trimEnd() : text, options: null };
  }
  // The tag line holds nothing but the tag.
  if (text.slice(start + CHOICES_FENCE.length, afterTag).trim().length > 0) {
    return { body: text, options: null };
  }
  const rest = text.slice(afterTag + 1);
  const close = CLOSING_FENCE.exec(rest);
  if (close === null) {
    return { body: streaming ? text.slice(0, start).trimEnd() : text, options: null };
  }
  // Nothing may follow the closing fence: a block in the middle of a reply is code.
  if (rest.slice(close.index + close[0].length).trim().length > 0) {
    return { body: text, options: null };
  }
  const options = parseOptions(rest.slice(0, close.index));
  if (options === null) return { body: text, options: null };
  return { body: text.slice(0, start).trimEnd(), options };
}

/** Whether a reply could hold a block at all; the cheap check before parsing. */
export function mayHaveChoices(text: string): boolean {
  return text.includes(CHOICES_FENCE);
}

/**
 * Words that make an option unsafe to send from a notification, SPEC 5b. A
 * word matches where a word starts, so "deployment" and "pushed" match too:
 * a false refusal only costs the phone a tap into the app.
 */
export const DESTRUCTIVE_WORDS = [
  "delete",
  "remove",
  "drop",
  "reset",
  "wipe",
  "revoke",
  "rotate",
  "overwrite",
  "discard",
  "force",
  "uninstall",
  "deploy",
  "publish",
  "merge",
  "push",
  "pay",
  "buy",
  "send",
  "sign out",
  "cancel",
] as const;

const DESTRUCTIVE_PATTERN = new RegExp(
  `\\b(?:${DESTRUCTIVE_WORDS.map((word) => word.replace(/\s+/g, "[\\s-]*")).join("|")})`,
  "i",
);

export const hasDestructiveWord = (text: string): boolean => DESTRUCTIVE_PATTERN.test(text);
