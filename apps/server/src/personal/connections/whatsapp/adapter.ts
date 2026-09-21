import { WHATSAPP_DEFAULT_DAILY_SEND_CAP } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import type { ConnectionVendorAdapter, ConnectionVendorCall } from "../adapters.ts";
import { vendorFailure } from "../vendors/vendorHttp.ts";
import { wrapInboundMessages } from "./inbound.ts";
import { checkPacing, typingDelayMs } from "./pacing.ts";
import {
  chatListExpression,
  conversationExpression,
  decodeChatList,
  decodeConversation,
  decodeOwnProfile,
  decodeSendConfirmation,
  ownProfileExpression,
  sendConfirmationExpression,
} from "./pageShape.ts";
import { mintRecipientRef, readRecipientRef, RECIPIENT_REF_REFUSAL } from "./recipientRef.ts";
import { resolveRecipient, type WhatsAppChat } from "./recipients.ts";
import type { WhatsAppSendLog } from "./sendLog.ts";
import type { WhatsAppSession } from "./session.ts";

/**
 * WhatsApp, driven through the shared browser as the owner's own account.
 *
 * Two rules shape everything below. The first is that a recipient is never
 * model-supplied: every destination arrives as a reference this server minted
 * from a chat list it read off the owner's page, and it is re-checked against
 * a freshly read list immediately before anything is typed. The second is that
 * a page which is not the shape we expect stops the call — no fallback click,
 * and above all no second attempt at a send whose delivery we could not
 * confirm, because a duplicate message to a real person is a mistake they see.
 */

/** How many rows a name is resolved against. Deep enough to find a real chat. */
const RESOLUTION_DEPTH = 200;

/** After Enter, before reading the bubble back. */
const CONFIRMATION_SETTLE_MS = 1_500;

const VENDOR_SCHEMAS: Readonly<Record<string, string>> = {
  "whatsapp.list_chats": "whatsapp/web-chat-list@2026-09-21",
  "whatsapp.search_contacts": "whatsapp/web-chat-list@2026-09-21",
  "whatsapp.read_chat": "whatsapp/web-conversation@2026-09-21",
  "whatsapp.mark_read": "whatsapp/web-conversation@2026-09-21",
  "whatsapp.send_message": "whatsapp/web-send@2026-09-21",
};

const asString = (value: unknown) => (typeof value === "string" ? value : "");
const asNumber = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export const makeWhatsAppAdapter = (input: {
  readonly session: WhatsAppSession["Service"];
  readonly sendLog: WhatsAppSendLog["Service"];
  /**
   * How the human-speed pauses are taken. Injected so a test can assert the
   * durations that were asked for instead of waiting them out: a suite that
   * really slept through a twenty-second typing delay would be a suite nobody
   * runs.
   */
  readonly pause?: (milliseconds: number) => Effect.Effect<void>;
}): ConnectionVendorAdapter => {
  const { session, sendLog } = input;
  const pause = input.pause ?? ((milliseconds) => Effect.sleep(`${milliseconds} millis`));
  /**
   * One send at a time for this connection.
   *
   * Two sends interleaved would share one tab and one composer, and the second
   * could type into the first one's conversation. There is one WhatsApp
   * connection by construction, so one permit is per-connection.
   */
  const sendLock = Semaphore.makeUnsafe(1);

  const fail = (operationId: string, detail: string, unauthorized?: boolean) =>
    Effect.fail(vendorFailure(operationId, detail, unauthorized));

  /** Any page-shape failure becomes the vendor error the gateway reports. */
  const page = <A>(operationId: string, effect: Effect.Effect<A, { readonly detail: string }>) =>
    effect.pipe(
      Effect.mapError((error) =>
        vendorFailure(
          operationId,
          error.detail,
          // A logged-out session is not a broken build: it moves the
          // connection to needs_reauth so the owner is offered the QR again.
          error.detail.includes("QR code"),
        ),
      ),
    );

  const readChats = (operationId: string, limit: number) =>
    session.ensureOpen().pipe(
      Effect.mapError((error) => vendorFailure(operationId, error.detail)),
      Effect.andThen(
        session
          .read(chatListExpression(limit))
          .pipe(Effect.mapError((error) => vendorFailure(operationId, error.detail))),
      ),
      Effect.flatMap((raw) => page(operationId, decodeChatList(raw))),
      Effect.map((read) => read.chats as ReadonlyArray<WhatsAppChat>),
    );

  const requireRecipient = (operationId: string, call: ConnectionVendorCall) => {
    const ref = readRecipientRef(asString(call.arguments["recipient"]));
    return ref === null ? fail(operationId, RECIPIENT_REF_REFUSAL) : Effect.succeed(ref);
  };

  /**
   * Opens a conversation and proves it is the right one before anything else
   * happens in it. The page's own header is the check: a click that landed on
   * a different row, or on nothing, stops here rather than in the composer.
   */
  const openAndConfirm = (operationId: string, chatId: string, displayName: string) =>
    session.openChat(chatId).pipe(
      Effect.mapError((error) => vendorFailure(operationId, error.detail)),
      Effect.andThen(
        session
          .read(sendConfirmationExpression())
          .pipe(Effect.mapError((error) => vendorFailure(operationId, error.detail))),
      ),
      Effect.flatMap((raw) => page(operationId, decodeSendConfirmation(raw))),
      Effect.flatMap((read) =>
        read.headerTitle === displayName
          ? Effect.succeed(read)
          : fail(
              operationId,
              `hbots opened a WhatsApp conversation and the page says it is with ${read.headerTitle === null ? "nobody" : `"${read.headerTitle}"`}, not "${displayName}". It stopped rather than act in the wrong conversation. Nothing was sent.`,
            ),
      ),
    );

  const sendMessage = Effect.fn("whatsapp.send_message")(function* (call: ConnectionVendorCall) {
    const operationId = call.operationId;
    const recipient = yield* requireRecipient(operationId, call);
    const text = asString(call.arguments["text"]);
    if (recipient.isGroup || recipient.phoneNumber === null) {
      return yield* fail(
        operationId,
        "hbots only sends WhatsApp messages to one person whose number it can show the owner. Nothing was sent.",
      );
    }

    // Re-resolved against a list read just now, not against the reference.
    // The reference proves the server minted it; this proves the conversation
    // is still there and still that number.
    const chats = yield* readChats(operationId, RESOLUTION_DEPTH);
    const current = chats.find((chat) => chat.chatId === recipient.chatId);
    if (current === undefined) {
      return yield* fail(
        operationId,
        `The conversation with ${recipient.displayName} is no longer in the owner's recent chats, so hbots did not send anything. Look the contact up again.`,
      );
    }
    if (current.phoneNumber !== recipient.phoneNumber || current.isGroup) {
      return yield* fail(
        operationId,
        `The conversation with ${recipient.displayName} is not the one this was approved for any more. Nothing was sent.`,
      );
    }

    const nowMs = yield* Clock.currentTimeMillis;
    const now = DateTime.makeUnsafe(nowMs);
    const cap = call.settings.whatsappDailySendCap ?? WHATSAPP_DEFAULT_DAILY_SEND_CAP;
    const sentAtMs = yield* sendLog
      .recentSends(call.connectionId, now)
      .pipe(
        Effect.mapError(() =>
          vendorFailure(
            operationId,
            "Could not read the WhatsApp send history, so nothing was sent.",
          ),
        ),
      );
    const pacing = checkPacing({ dailySendCap: cap, sentAtMs, nowMs });
    // Refused, never queued. A run that waits out a cap is a run that spends
    // tomorrow's budget without anyone deciding to.
    if (!pacing.allowed) return yield* fail(operationId, pacing.reason);

    const before = yield* openAndConfirm(operationId, current.chatId, current.displayName);

    // Typed at something like the speed a person types it.
    yield* pause(typingDelayMs(text));
    yield* session
      .typeMessage(text)
      .pipe(Effect.mapError((error) => vendorFailure(operationId, error.detail)));
    yield* session
      .submit()
      .pipe(Effect.mapError((error) => vendorFailure(operationId, error.detail)));

    // From here on the message may already be on someone's phone, so the only
    // question left is what we can prove — never whether to try again.
    yield* pause(CONFIRMATION_SETTLE_MS);
    const sentAt = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
    yield* sendLog
      .record({
        connectionId: call.connectionId,
        recipientNumber: current.phoneNumber,
        sentAt,
      })
      .pipe(Effect.ignore);

    // A read that fails here is "we cannot tell", which is treated exactly
    // like a bubble that does not match: unconfirmed, and never retried.
    const after = yield* session.read(sendConfirmationExpression()).pipe(
      Effect.mapError((error) => vendorFailure(operationId, error.detail)),
      Effect.flatMap((raw) => page(operationId, decodeSendConfirmation(raw))),
      Effect.option,
    );
    const confirmed =
      Option.isSome(after) &&
      after.value.lastOutgoingText === text &&
      after.value.lastOutgoingHasStatus &&
      after.value.lastOutgoingText !== before.lastOutgoingText;

    if (!confirmed) {
      return yield* fail(
        operationId,
        `hbots typed the message to ${recipient.displayName} and pressed send, but could not confirm on the page that it went. It will not try again: the message may already have arrived, and a duplicate is something they would see. Ask the owner to look at WhatsApp.`,
      );
    }
    return {
      recipient: `${current.displayName} (${current.phoneNumber})`,
      sentAtIso: DateTime.formatIso(sentAt),
      delivered: true,
    };
  });

  const execute: ConnectionVendorAdapter["execute"] = (call) =>
    Effect.gen(function* () {
      const operationId = call.operationId;
      switch (operationId) {
        case "whatsapp.list_chats": {
          const limit = asNumber(call.arguments["limit"], 20);
          const chats = yield* readChats(operationId, limit);
          // Names, unread state and a reference to act on. No message bodies:
          // reading someone's words is `read_chat`, deliberately separate.
          return {
            chats: chats.map((chat) => ({
              recipient: mintRecipientRef(chat),
              name: chat.displayName,
              isGroup: chat.isGroup,
              unread: chat.unread,
            })),
          };
        }
        case "whatsapp.search_contacts": {
          const chats = yield* readChats(operationId, RESOLUTION_DEPTH);
          const resolution = resolveRecipient({
            requested: asString(call.arguments["name"]),
            chats,
          });
          // Zero matches and several matches are both refusals, and both say
          // what was actually there. Picking one would be the server guessing
          // who the owner meant to message.
          if (resolution._tag === "refused") return yield* fail(operationId, resolution.reason);
          return {
            contact: {
              recipient: mintRecipientRef(resolution.chat),
              name: resolution.chat.displayName,
              number: resolution.chat.phoneNumber,
            },
            note: "Use this `recipient` value to read or send. It is the only way to name this person, and it stops working when hbots restarts.",
          };
        }
        case "whatsapp.read_chat": {
          const recipient = yield* requireRecipient(operationId, call);
          yield* openAndConfirm(operationId, recipient.chatId, recipient.displayName);
          const limit = asNumber(call.arguments["limit"], 20);
          const read = yield* session.read(conversationExpression(limit)).pipe(
            Effect.mapError((error) => vendorFailure(operationId, error.detail)),
            Effect.flatMap((raw) => page(operationId, decodeConversation(raw))),
          );
          // Quoted and labelled on the way out: anyone with the owner's number
          // can write into this, and a full-access bot reads it.
          const wrapped = wrapInboundMessages({
            chatDisplayName: recipient.displayName,
            messages: read.messages,
          });
          return {
            chat: wrapped.chat,
            standingRule: wrapped.standingRule,
            messages: wrapped.messages,
          };
        }
        case "whatsapp.mark_read": {
          const recipient = yield* requireRecipient(operationId, call);
          // Opening a conversation is what clears its badge; there is no other
          // control to press, and the list read below is the proof it worked.
          yield* openAndConfirm(operationId, recipient.chatId, recipient.displayName);
          const chats = yield* readChats(operationId, RESOLUTION_DEPTH);
          const current = chats.find((chat) => chat.chatId === recipient.chatId);
          return {
            chat: recipient.displayName,
            markedRead: current === undefined ? false : !current.unread,
          };
        }
        case "whatsapp.send_message":
          return yield* sendLock.withPermit(sendMessage(call));
        default:
          return yield* fail(
            operationId,
            "The WhatsApp adapter does not implement this operation.",
          );
      }
    });

  const validate: ConnectionVendorAdapter["validate"] = () =>
    Effect.gen(function* () {
      const operationId = "whatsapp.validate";
      yield* session
        .ensureOpen()
        .pipe(Effect.mapError((error) => vendorFailure(operationId, error.detail)));
      // Control comes back to the server here: the owner has finished with the
      // QR code, and the page is about to be read.
      yield* session.handBack().pipe(Effect.ignore);
      const profile = yield* session.read(ownProfileExpression()).pipe(
        Effect.mapError((error) => vendorFailure(operationId, error.detail)),
        Effect.flatMap((raw) => page(operationId, decodeOwnProfile(raw))),
      );
      if (profile.phoneNumber === null) {
        return yield* fail(
          operationId,
          "hbots opened WhatsApp Web but could not read which account is signed in, so it will not claim one is connected.",
        );
      }
      return {
        account: {
          accountId: profile.phoneNumber,
          accountName: profile.displayName ?? profile.phoneNumber,
          teamId: null,
          teamName: null,
        },
        // There is no token and so no scopes. `null` is this vendor saying it
        // cannot report any, which is not the same as reporting none.
        grantedScopes: null,
        verifiedCapabilities: [
          "whatsapp.list_chats",
          "whatsapp.search_contacts",
          "whatsapp.read_chat",
          "whatsapp.mark_read",
          "whatsapp.send_message",
        ],
      };
    });

  return {
    vendorId: "whatsapp",
    vendorSchema: (operationId) => {
      const schema = VENDOR_SCHEMAS[operationId];
      return schema === undefined
        ? fail(operationId, `The WhatsApp adapter does not speak for ${operationId}. Nothing ran.`)
        : Effect.succeed(schema);
    },
    execute,
    validate,
  };
};
