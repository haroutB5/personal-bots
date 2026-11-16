/** A bot's trailing `choices` fence becomes tap-to-answer buttons; malformed blocks stay code. */

import type { ConversationItem } from "./conversationModel.ts";

import { mayHaveChoices, splitChoices } from "@t3tools/contracts";

export {
  CHOICE_MAX_CHARS,
  CHOICES_FENCE,
  CHOICES_MAX,
  CHOICES_MIN,
  mayHaveChoices,
  splitChoices,
  type ChoicesSplit,
} from "@t3tools/contracts";

/**
 * Where a set of choices stands. `open`: the latest reply's, tappable unless
 * the chat is busy. `used`: the owner sent something after it, so the set is
 * greyed out; `picked` is the option that message was, when it was one.
 */
export type ChoicesState =
  | { readonly kind: "open"; readonly disabled: boolean }
  | { readonly kind: "used"; readonly picked: string | null };

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
