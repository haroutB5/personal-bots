/**
 * Tap-to-answer choices. A bot ends a reply with a fenced block tagged
 * `choices`, one short option per line:
 *
 *     ```choices
 *     Yes, ship it
 *     Not yet
 *     ```
 *
 * The chat draws the block as buttons; a tap sends that line as the owner's
 * next message. Only a well-formed block at the very end of the reply becomes
 * buttons: anything else (no closing fence, one option, nine, a line too long
 * to be a button, more text after it) is left to the markdown renderer, which
 * shows it as the plain code block it looks like.
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

/**
 * Splits a reply into its text and its trailing choices. `streaming`: a block
 * still being written (opened, not closed) is held back so it does not flash
 * as a code block and then turn into buttons.
 */
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
