import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  LOGGED_OUT_MESSAGE,
  PAGE_CHANGED_MESSAGE,
  PAGE_SELECTORS,
  chatListExpression,
  conversationExpression,
  decodeChatList,
  decodeConversation,
  decodeOwnProfile,
  decodeSendConfirmation,
  ownProfileExpression,
  sendConfirmationExpression,
} from "./pageShape.ts";

const READY_LIST = {
  shape: "ready",
  chats: [
    {
      chatId: "447700900001@c.us",
      displayName: "Mum",
      phoneNumber: "+447700900001",
      isGroup: false,
      unread: true,
      lastMessagePreview: null,
    },
  ],
};

describe("whatsapp page shape", () => {
  it.effect("decodes a page that is the shape this build was written against", () =>
    Effect.gen(function* () {
      const read = yield* decodeChatList(READY_LIST);
      expect(read.chats[0]?.displayName).toBe("Mum");
    }),
  );

  it.effect("refuses the QR screen as a session to reconnect, not as a broken build", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeChatList({ shape: "logged_out", chats: [] }));
      expect(error.detail).toBe(LOGGED_OUT_MESSAGE);
    }),
  );

  it.effect("refuses an unrecognised page rather than reporting an empty chat list", () =>
    Effect.gen(function* () {
      // The failure that matters: a WhatsApp redesign must not read as "the
      // owner has no conversations", which would make every send refuse for
      // the wrong reason and every read look answered.
      const error = yield* Effect.flip(decodeChatList({ shape: "unrecognised", chats: [] }));
      expect(error.detail).toBe(PAGE_CHANGED_MESSAGE);
    }),
  );

  it.effect("refuses a read whose fields drifted, even when it says it is ready", () =>
    Effect.gen(function* () {
      for (const drifted of [
        { shape: "ready" },
        { shape: "ready", chats: [{ chatId: "x@c.us", displayName: "Mum" }] },
        { shape: "ready", chats: [{ ...READY_LIST.chats[0], isGroup: "no" }] },
        { shape: "ready", chats: [{ ...READY_LIST.chats[0], displayName: "" }] },
        { shape: "fine", chats: [] },
        null,
        "ready",
      ]) {
        const error = yield* Effect.flip(decodeChatList(drifted));
        expect(error._tag, JSON.stringify(drifted)).toBe("WhatsAppPageShapeError");
      }
    }),
  );

  it.effect("holds every read to the same rule", () =>
    Effect.gen(function* () {
      const profile = yield* decodeOwnProfile({
        shape: "ready",
        displayName: "Harout",
        phoneNumber: "+447700900000",
      });
      expect(profile.phoneNumber).toBe("+447700900000");
      yield* Effect.flip(decodeOwnProfile({ shape: "unrecognised" }));

      const conversation = yield* decodeConversation({
        shape: "ready",
        headerTitle: "Mum",
        messages: [{ author: "Mum", fromOwner: false, sentAtIso: "", text: "hi" }],
      });
      expect(conversation.messages).toHaveLength(1);
      yield* Effect.flip(decodeConversation({ shape: "ready", headerTitle: "Mum" }));

      const sent = yield* decodeSendConfirmation({
        shape: "ready",
        headerTitle: "Mum",
        lastOutgoingText: "hello",
        lastOutgoingHasStatus: true,
        composerEmpty: true,
      });
      expect(sent.lastOutgoingHasStatus).toBe(true);
      yield* Effect.flip(
        decodeSendConfirmation({ shape: "ready", headerTitle: "Mum", lastOutgoingText: "hello" }),
      );
    }),
  );

  it("builds expressions that parse, and that only read the selectors on record", () => {
    for (const source of [
      chatListExpression(20),
      ownProfileExpression(),
      conversationExpression(30),
      sendConfirmationExpression(),
    ]) {
      // If this throws, every page read would fail at runtime with a syntax
      // error the refusal message could not explain.
      expect(() => new Function(`return ${source}`)).not.toThrow();
      expect(source).toContain(PAGE_SELECTORS.chatListPane);
    }
  });
});
