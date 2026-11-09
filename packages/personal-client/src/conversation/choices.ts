/** A bot's trailing `choices` fence becomes tap-to-answer buttons; malformed blocks stay code. */

import type { ConversationItem } from "./conversationModel.ts";

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

/**
 * Where a set of choices stands. `open`: the latest reply's, tappable unless
 * the chat is busy. `used`: the owner sent something after it, so the set is
 * greyed out; `picked` is the option that message was, when it was one.
 */
export type ChoicesState =
  | { readonly kind: "open"; readonly disabled: boolean }
  | { readonly kind: "used"; readonly picked: string | null };

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

/** Where each reply's choices stand: open until the owner speaks, then used with the pick. */
export function choicesStates(
  items: ReadonlyArray<ConversationItem>,
  busy: boolean,
): ReadonlyMap<string, ChoicesState> {
  const states = new Map<string, ChoicesState>();
  let laterOwnerText: string | null | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind !== "message" && item.kind !== "group-message") continue;
    if (item.message.role === "user") {
      laterOwnerText = item.message.text.trim();
      continue;
    }
    if (item.message.role !== "assistant" || !mayHaveChoices(item.message.text)) continue;
    const options = splitChoices(item.message.text).options;
    if (options === null) continue;
    states.set(
      item.id,
      laterOwnerText === undefined
        ? { kind: "open", disabled: busy }
        : { kind: "used", picked: options.find((option) => option === laterOwnerText) ?? null },
    );
  }
  return states;
}
