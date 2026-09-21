import * as NodeCrypto from "node:crypto";

import type { WhatsAppChat } from "./recipients.ts";

/**
 * The only thing that can name a recipient.
 *
 * A WhatsApp operation never takes a name or a number from the model. It takes
 * one of these references, and the server mints them exclusively from chats it
 * read off the owner's own logged-in page. The reference carries the chat's
 * identity and is authenticated with a key that exists only inside this
 * process, so a bot cannot construct, edit or guess one: changing a single
 * character of a reference makes it stop being a reference at all.
 *
 * That is what lets the approval card be honest. The card has to show the
 * display name *and* the number the message will actually go to, and it is
 * written before any adapter runs, so the destination has to be readable from
 * the validated arguments alone. Carrying it inside an authenticated reference
 * is how it gets there without ever having been model-supplied.
 *
 * The key is per-process and random, so references do not survive a restart.
 * That is deliberate: a reference is a handle on a chat list the server has
 * just read, not a durable address, and an expired one costs a bot one cheap
 * `search_contacts` call.
 */

const KEY = NodeCrypto.randomBytes(32);
const PREFIX = "wa1";

export interface WhatsAppRecipient {
  readonly chatId: string;
  readonly displayName: string;
  readonly phoneNumber: string | null;
  readonly isGroup: boolean;
}

const sign = (payload: string) =>
  NodeCrypto.createHmac("sha256", KEY).update(payload).digest("base64url");

export const mintRecipientRef = (chat: WhatsAppChat): string => {
  const payload = Buffer.from(
    JSON.stringify({
      chatId: chat.chatId,
      displayName: chat.displayName,
      phoneNumber: chat.phoneNumber,
      isGroup: chat.isGroup,
    }),
    "utf8",
  ).toString("base64url");
  return `${PREFIX}.${payload}.${sign(payload)}`;
};

/** Null for anything this process did not mint, including a tampered one. */
export const readRecipientRef = (ref: string): WhatsAppRecipient | null => {
  const parts = ref.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, signature] = parts as [string, string, string];
  const expected = sign(payload);
  // Constant time, and length-guarded: timingSafeEqual throws on a mismatch.
  if (
    signature.length !== expected.length ||
    !NodeCrypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return null;
    const value = decoded as Record<string, unknown>;
    if (
      typeof value["chatId"] !== "string" ||
      typeof value["displayName"] !== "string" ||
      typeof value["isGroup"] !== "boolean" ||
      !(typeof value["phoneNumber"] === "string" || value["phoneNumber"] === null)
    ) {
      return null;
    }
    return {
      chatId: value["chatId"],
      displayName: value["displayName"],
      phoneNumber: value["phoneNumber"],
      isGroup: value["isGroup"],
    };
  } catch {
    return null;
  }
};

export const isRecipientRef = (value: string) => readRecipientRef(value) !== null;

export const RECIPIENT_REF_REFUSAL =
  "That is not a contact hbots issued. Recipients cannot be typed: call whatsapp.search_contacts or whatsapp.list_chats first and use the `recipient` value it gives you for the person you mean. Nothing was sent.";
