/**
 * Turning what a bot asked for into a person the owner actually talks to.
 *
 * This is the rule the whole WhatsApp connection rests on: a recipient is
 * never model-supplied. The bot names a contact, and the server resolves that
 * name against the owner's real chat list, read off the logged-in page. A name
 * matching nothing is refused; a name matching more than one is refused; and a
 * phone number is refused whatever it matches, because a hallucinated or
 * prompt-injected number must not be able to become a destination by being
 * typed. Everything here is pure, so the refusals can be tested without a
 * browser and without a real account.
 */

export interface WhatsAppChat {
  /** WhatsApp's own id for the conversation, as the page reports it. */
  readonly chatId: string;
  readonly displayName: string;
  /** Null for a group, and for any chat whose number the page did not give us. */
  readonly phoneNumber: string | null;
  readonly isGroup: boolean;
  readonly unread: boolean;
  readonly lastMessagePreview: string | null;
}

export type RecipientResolution =
  | { readonly _tag: "resolved"; readonly chat: WhatsAppChat }
  | { readonly _tag: "refused"; readonly reason: string };

/**
 * Anything a person could reasonably have meant as a number: digits with the
 * punctuation phone numbers are written with, and enough of them to be one.
 *
 * Deliberately generous. A false positive costs a bot one refusal and a
 * clearer retry; a false negative is a message to a stranger sent in the
 * owner's name, which cannot be taken back.
 */
const PHONE_LIKE = /(?:\+|\b00)?[\d][\d\s().-]{5,}\d/u;

const normalize = (value: string) =>
  value
    .normalize("NFD")
    // Strip combining marks so "Zoë" and "Zoe" are the same person.
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();

const listNames = (chats: ReadonlyArray<WhatsAppChat>) =>
  chats.map((entry) => entry.displayName).join(", ");

export function resolveRecipient(input: {
  readonly requested: string;
  readonly chats: ReadonlyArray<WhatsAppChat>;
}): RecipientResolution {
  const requested = input.requested.trim();
  if (requested.length === 0) {
    return { _tag: "refused", reason: "No contact was named, so nothing was sent." };
  }
  // Before any matching: a number never resolves, not even to the chat it is
  // the title of. This is the one refusal that has to hold against a message
  // the bot read somewhere else and believed.
  if (PHONE_LIKE.test(requested)) {
    return {
      _tag: "refused",
      reason:
        "That looks like a phone number, and hbots never sends to a number a bot supplies, even one already in the chat list. Name the person as they appear in the owner's WhatsApp, or ask the owner to message them first.",
    };
  }

  const wanted = normalize(requested);
  const exact = input.chats.filter((entry) => normalize(entry.displayName) === wanted);
  const candidates =
    exact.length > 0
      ? exact
      : input.chats.filter((entry) => normalize(entry.displayName).includes(wanted));

  if (candidates.length === 0) {
    return {
      _tag: "refused",
      reason:
        input.chats.length === 0
          ? `There is no conversation with "${requested}": the owner's chat list came back empty, so nothing was sent.`
          : `There is no conversation with "${requested}". Open chats are: ${listNames(input.chats)}. Nothing was sent.`,
    };
  }
  if (candidates.length > 1) {
    return {
      _tag: "refused",
      reason: `"${requested}" matches more than one conversation: ${listNames(candidates)}. Ask the owner which one they mean and use that exact name. Nothing was sent.`,
    };
  }

  const chat = candidates[0]!;
  if (chat.isGroup) {
    return {
      _tag: "refused",
      reason: `"${chat.displayName}" is a group. hbots only sends to one person at a time, so the owner can see the single number a message goes to. Nothing was sent.`,
    };
  }
  if (chat.phoneNumber === null || chat.phoneNumber.trim().length === 0) {
    return {
      _tag: "refused",
      reason: `hbots could not read the number behind "${chat.displayName}", and it will not send where it cannot show the owner the destination. Nothing was sent.`,
    };
  }
  return { _tag: "resolved", chat };
}
