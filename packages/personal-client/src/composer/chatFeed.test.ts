import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildConversationItems } from "../conversation/conversationModel.ts";
import type { TimelineEntry } from "../conversation/types.ts";
import {
  createMemoryBlobStore,
  createMemoryKeyValueStore,
  createSequentialIds,
} from "../testing/fakes.ts";
import { configureOutbox, enqueueOutboxEntry, getOutboxSnapshot } from "./outbox.ts";
import { configureOutboxBlobs, getOutboxBlob, putOutboxBlobs } from "./outboxBlobs.ts";

const AT = "2026-11-04T10:00:00.000Z";

describe("a chat feed and an outbox on in-memory fakes", () => {
  it("builds the feed rows and keeps a queued message with its bytes", async () => {
    const entry = {
      id: "entry-1",
      kind: "message",
      createdAt: AT,
      message: {
        id: MessageId.make("message-1"),
        role: "user",
        text: "Ship it",
        turnId: null,
        streaming: false,
        createdAt: AT,
        updatedAt: AT,
      },
    } as unknown as TimelineEntry;

    const items = buildConversationItems([entry]);
    expect(items.some((item) => item.kind === "message" && item.message.text === "Ship it")).toBe(
      true,
    );

    const kv = createMemoryKeyValueStore();
    const blobs = createMemoryBlobStore<Uint8Array>((bytes) => bytes.byteLength);
    configureOutbox({ store: kv, ids: createSequentialIds() });
    configureOutboxBlobs(blobs);

    const queued = enqueueOutboxEntry({
      id: "message-1",
      kind: "turn",
      environmentId: "env",
      threadId: "thread-1",
      groupId: null,
      text: "Ship it",
      sendText: "Ship it",
      createdAt: AT,
      replyTo: null,
      turn: null,
      attachments: [],
    });
    expect(queued?.commandId).toBe("outbox:message-1");
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["message-1"]);
    expect(kv.getItem("t3.personal.outbox.v1")).toContain("Ship it");

    await putOutboxBlobs("message-1", [{ id: "a1", blob: new Uint8Array([1, 2, 3]) }]);
    await expect(getOutboxBlob<Uint8Array>("message-1", "a1")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});
