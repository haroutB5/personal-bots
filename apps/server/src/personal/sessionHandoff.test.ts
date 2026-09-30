import { assert, describe, it } from "@effect/vitest";
import { MessageId } from "@t3tools/contracts";

import { buildChatHandoff, HANDOFF_MAX_CHARS } from "./sessionHandoff.ts";

const message = (
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  attachments?: ReadonlyArray<{ readonly name: string }>,
) => ({
  id: MessageId.make(id),
  role,
  text,
  ...(attachments === undefined
    ? {}
    : {
        attachments: attachments.map((attachment, index) => ({
          type: "image" as const,
          id: `${id}-attachment-${index}`,
          name: attachment.name,
          mimeType: "image/png",
          sizeBytes: 5,
        })),
      }),
});

describe("buildChatHandoff", () => {
  it("carries earlier messages in order, without the one being sent", () => {
    const handoff = buildChatHandoff({
      messages: [
        message("m1", "user", "Plan the trip to Lisbon."),
        message("m2", "assistant", "Three days: Alfama, Belem, Sintra."),
        message("m3", "system", "internal notice"),
        message("m4", "user", "What about this?", [{ name: "photo.png" }]),
      ],
      currentMessageId: MessageId.make("m4"),
    });
    assert.isDefined(handoff);
    assert.include(handoff!, "Earlier in this chat");
    assert.include(
      handoff!,
      "Owner: Plan the trip to Lisbon.\nYou: Three days: Alfama, Belem, Sintra.",
    );
    assert.notInclude(handoff!, "What about this?");
    assert.notInclude(handoff!, "internal notice");
  });

  it("names attachments of earlier messages", () => {
    const handoff = buildChatHandoff({
      messages: [
        message("m1", "user", "", [{ name: "receipt.png" }]),
        message("m2", "user", "Next"),
      ],
      currentMessageId: MessageId.make("m2"),
    });
    assert.include(handoff!, "Owner:  [attached: receipt.png]");
  });

  it("returns nothing for a chat with no earlier messages, or no room", () => {
    assert.isUndefined(
      buildChatHandoff({
        messages: [message("m1", "user", "First message")],
        currentMessageId: MessageId.make("m1"),
      }),
    );
    assert.isUndefined(
      buildChatHandoff({ messages: [message("m1", "user", "Hi")], maxChars: 100 }),
    );
  });

  it("keeps the newest messages when the budget is short, and caps each one", () => {
    const messages = Array.from({ length: 60 }, (_, index) =>
      message(`m${index}`, index % 2 === 0 ? "user" : "assistant", `${index} ${"x".repeat(3_000)}`),
    );
    const handoff = buildChatHandoff({ messages })!;
    assert.isAtMost(handoff.length, HANDOFF_MAX_CHARS);
    assert.include(handoff, "You: 59 ");
    assert.notInclude(handoff, "Owner: 0 ");
    assert.include(handoff, "… (cut)");
  });
});
