import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  enqueueOutboxEntry,
  getOutboxSnapshot,
  hasOutboxForThread,
  markOutboxFailed,
  type NewOutboxEntry,
  OUTBOX_STORAGE_KEY,
  outboxCommandId,
  outboxEntriesForThread,
  type OutboxStorage,
  removeOutboxEntry,
  resetOutboxForTesting,
  retryOutboxEntry,
  setOutboxSending,
} from "./outbox";

function memoryStorage(initial?: string): OutboxStorage & { raw: () => string | null } {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    raw: () => value,
  };
}

const turn = {
  modelSelection: { instanceId: "claude", model: "sonnet" },
  titleSeed: "hello",
  runtimeMode: "full-access",
  interactionMode: "default",
} as never;

function entry(id: string, threadId = "t1", extra: Partial<NewOutboxEntry> = {}): NewOutboxEntry {
  return {
    id,
    kind: "turn",
    environmentId: "env",
    threadId,
    groupId: null,
    text: `text ${id}`,
    sendText: `text ${id}`,
    createdAt: "2026-10-08T12:00:00.000Z",
    replyTo: null,
    turn,
    attachments: [],
    ...extra,
  };
}

describe("send queue store", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
    resetOutboxForTesting(storage);
  });
  afterEach(() => resetOutboxForTesting(undefined));

  it("keeps messages in the order they were typed, across chats", () => {
    enqueueOutboxEntry(entry("a", "t1"));
    enqueueOutboxEntry(entry("b", "t2"));
    enqueueOutboxEntry(entry("c", "t1"));
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(outboxEntriesForThread("t1").map((item) => item.id)).toEqual(["a", "c"]);
    expect(hasOutboxForThread("t2")).toBe(true);
    expect(hasOutboxForThread("t3")).toBe(false);
  });

  it("gives every message its own stable command id, derived from the message id", () => {
    const first = enqueueOutboxEntry(entry("m-1"));
    expect(first?.commandId).toBe(outboxCommandId("m-1"));
    expect(outboxCommandId("m-1")).toBe("outbox:m-1");
    // Typing the same id again (a double tap) is the same entry, not a second message.
    const again = enqueueOutboxEntry(entry("m-1"));
    expect(again?.seq).toBe(first?.seq);
    expect(getOutboxSnapshot().entries).toHaveLength(1);
  });

  it("survives a reload: a new page reads the same queue back from the device", () => {
    enqueueOutboxEntry(entry("a"));
    enqueueOutboxEntry(entry("b", "t1", { replyTo: { messageId: "x", text: "q" } as never }));
    const saved = storage.raw();
    expect(saved).not.toBeNull();
    // A fresh page: nothing in memory, the same device storage.
    resetOutboxForTesting(memoryStorage(saved ?? undefined));
    const after = getOutboxSnapshot().entries;
    expect(after.map((item) => [item.id, item.commandId, item.status])).toEqual([
      ["a", "outbox:a", "waiting"],
      ["b", "outbox:b", "waiting"],
    ]);
    expect(after[1]?.replyTo).toEqual({ messageId: "x", text: "q" });
    expect(after[0]?.createdAt).toBe("2026-10-08T12:00:00.000Z");
    // The next message continues the order instead of restarting it.
    const next = enqueueOutboxEntry(entry("c"));
    expect(next?.seq).toBeGreaterThan(after[1]!.seq);
  });

  it("ignores damaged data instead of breaking the app", () => {
    resetOutboxForTesting(memoryStorage("{not json"));
    expect(getOutboxSnapshot().entries).toEqual([]);
    resetOutboxForTesting(
      memoryStorage(
        JSON.stringify([
          { id: 1 },
          null,
          "x",
          { ...entry("ok"), commandId: "outbox:ok", seq: 1, queuedAt: 1 },
        ]),
      ),
    );
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["ok"]);
  });

  it("cancel removes a waiting message from the queue and from the device", () => {
    enqueueOutboxEntry(entry("a"));
    enqueueOutboxEntry(entry("b"));
    expect(removeOutboxEntry("a")?.id).toBe("a");
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["b"]);
    expect(JSON.parse(storage.raw() ?? "[]").map((item: { id: string }) => item.id)).toEqual(["b"]);
    expect(removeOutboxEntry("missing")).toBeNull();
  });

  it("says no when the device refuses the write, so the caller keeps the draft", () => {
    resetOutboxForTesting({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(enqueueOutboxEntry(entry("a"))).toBeNull();
    expect(getOutboxSnapshot().entries).toEqual([]);
  });

  it("works for the life of the page when there is no storage at all", () => {
    resetOutboxForTesting(null);
    expect(enqueueOutboxEntry(entry("a"))?.id).toBe("a");
    expect(getOutboxSnapshot().entries).toHaveLength(1);
  });

  it("Retry after the laptop refused a message uses a fresh command id; after silence it keeps its id", () => {
    enqueueOutboxEntry(entry("a"));
    enqueueOutboxEntry(entry("b"));
    markOutboxFailed("a", "Couldn't send: gone", true);
    markOutboxFailed("b", "Couldn't send: your laptop didn't answer. Try again.", false);
    retryOutboxEntry("a");
    retryOutboxEntry("b");
    const [a, b] = getOutboxSnapshot().entries;
    // Refused ids are remembered as refused by the server; a silent one may have landed.
    expect(a?.commandId).toBe("outbox:a:2");
    expect(a?.id).toBe("a");
    expect(a?.status).toBe("waiting");
    expect(b?.commandId).toBe("outbox:b");
    expect(b?.status).toBe("waiting");
  });

  it("tracks which message is being sent right now without touching the saved queue", () => {
    enqueueOutboxEntry(entry("a"));
    const saved = storage.raw();
    setOutboxSending("a", true);
    expect(getOutboxSnapshot().sending.has("a")).toBe(true);
    expect(storage.raw()).toBe(saved);
    setOutboxSending("a", false);
    expect(getOutboxSnapshot().sending.has("a")).toBe(false);
  });

  it("uses one storage key", () => {
    enqueueOutboxEntry(entry("a"));
    expect(OUTBOX_STORAGE_KEY).toBe("t3.personal.outbox.v1");
  });
});
