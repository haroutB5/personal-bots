import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  enqueueOutboxEntry,
  getOutboxSnapshot,
  hasOutboxForThread,
  markOutboxFailed,
  type NewOutboxEntry,
  OUTBOX_REMOVED_STORAGE_KEY,
  OUTBOX_STORAGE_KEY,
  outboxCommandId,
  outboxEntriesForThread,
  type OutboxStorage,
  removeOutboxEntry,
  resetOutboxForTesting,
  retryOutboxEntry,
  setOutboxSending,
  unwrittenOutboxRemovals,
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

/**
 * A device that refuses writes to some keys. `refuse(key, call)` is asked on every setItem; a true answer
 * throws as a full or blocked localStorage does.
 */
function flakyStorage(refuse: (key: string, call: number) => boolean) {
  const values = new Map<string, string>();
  const calls = new Map<string, number>();
  const storage: OutboxStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      const call = (calls.get(key) ?? 0) + 1;
      calls.set(key, call);
      if (refuse(key, call)) throw new Error("QuotaExceededError");
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return { storage, values, calls };
}

const queueIds = (values: Map<string, string>) =>
  (JSON.parse(values.get(OUTBOX_STORAGE_KEY) ?? "[]") as Array<{ id: string }>).map(
    (item) => item.id,
  );

describe("a removal the device refuses to write", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetOutboxForTesting(undefined);
  });

  it("cannot bring a cancelled message back after a reload: the id is marked removed", () => {
    vi.useFakeTimers();
    // The queue write is refused from the third write on; the few bytes of the mark fit.
    const device = flakyStorage((key, call) => key === OUTBOX_STORAGE_KEY && call >= 3);
    resetOutboxForTesting(device.storage);
    enqueueOutboxEntry(entry("keep"));
    enqueueOutboxEntry(entry("cancel me"));
    expect(queueIds(device.values)).toEqual(["keep", "cancel me"]);

    expect(removeOutboxEntry("cancel me")?.id).toBe("cancel me");
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["keep"]);
    // The queue on disk still holds the text...
    expect(queueIds(device.values)).toEqual(["keep", "cancel me"]);
    expect(unwrittenOutboxRemovals()).toBe(1);
    expect(JSON.parse(device.values.get(OUTBOX_REMOVED_STORAGE_KEY) ?? "[]")).toEqual([
      "cancel me",
    ]);

    // ...but a new page (same storage) does not read it back.
    resetOutboxForTesting(device.storage);
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["keep"]);
  });

  it("retries the write until the device takes it, then forgets the mark", () => {
    vi.useFakeTimers();
    const device = flakyStorage(
      (key, call) => key === OUTBOX_STORAGE_KEY && call >= 3 && call <= 5,
    );
    resetOutboxForTesting(device.storage);
    enqueueOutboxEntry(entry("a"));
    enqueueOutboxEntry(entry("b"));
    removeOutboxEntry("a"); // refused (write 3), marked
    expect(unwrittenOutboxRemovals()).toBe(1);

    vi.advanceTimersByTime(500); // write 4: refused again
    expect(unwrittenOutboxRemovals()).toBe(1);
    vi.advanceTimersByTime(2_000); // write 5: refused again
    expect(queueIds(device.values)).toEqual(["a", "b"]);
    vi.advanceTimersByTime(8_000); // write 6: taken
    expect(queueIds(device.values)).toEqual(["b"]);
    expect(unwrittenOutboxRemovals()).toBe(0);
    expect(device.values.has(OUTBOX_REMOVED_STORAGE_KEY)).toBe(false);

    // Nothing is left to retry.
    const writes = device.calls.get(OUTBOX_STORAGE_KEY);
    vi.advanceTimersByTime(120_000);
    expect(device.calls.get(OUTBOX_STORAGE_KEY)).toBe(writes);
  });

  it("keeps retrying for the life of the page when every write is refused, and hides the message meanwhile", () => {
    vi.useFakeTimers();
    let open = false;
    // The queue write after the first is refused, and so is the mark: only memory knows.
    const device = flakyStorage(
      (key, call) => !open && (key === OUTBOX_STORAGE_KEY ? call >= 2 : true),
    );
    resetOutboxForTesting(device.storage);
    enqueueOutboxEntry(entry("a")); // the one write that fits
    removeOutboxEntry("a");
    expect(unwrittenOutboxRemovals()).toBe(1);
    expect(getOutboxSnapshot().entries).toEqual([]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(unwrittenOutboxRemovals()).toBe(1);
    open = true;
    vi.advanceTimersByTime(60_000);
    expect(unwrittenOutboxRemovals()).toBe(0);
    expect(queueIds(device.values)).toEqual([]);
  });

  it("a later write that succeeds settles the removal too", () => {
    vi.useFakeTimers();
    const device = flakyStorage((key, call) => key === OUTBOX_STORAGE_KEY && call === 3);
    resetOutboxForTesting(device.storage);
    enqueueOutboxEntry(entry("a"));
    enqueueOutboxEntry(entry("b"));
    removeOutboxEntry("a"); // refused
    expect(unwrittenOutboxRemovals()).toBe(1);
    enqueueOutboxEntry(entry("c")); // taken: writes the queue without "a"
    expect(queueIds(device.values)).toEqual(["b", "c"]);
    expect(unwrittenOutboxRemovals()).toBe(0);
    expect(device.values.has(OUTBOX_REMOVED_STORAGE_KEY)).toBe(false);
  });

  it("after a reload with a writable device, the marks become pending cleanup and the queue is rewritten", () => {
    vi.useFakeTimers();
    // Page one: the queue write for the cancel is refused (write 3), the mark fits.
    const device = flakyStorage((key, call) => key === OUTBOX_STORAGE_KEY && call === 3);
    resetOutboxForTesting(device.storage);
    enqueueOutboxEntry(entry("keep"));
    enqueueOutboxEntry(entry("cancel me", "t1", { text: "private words" }));
    removeOutboxEntry("cancel me");
    expect(device.values.get(OUTBOX_STORAGE_KEY)).toContain("private words");
    expect(device.values.has(OUTBOX_REMOVED_STORAGE_KEY)).toBe(true);

    // Page two (a reload): storage writes fine now. Nothing shows in the queue...
    resetOutboxForTesting(device.storage);
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["keep"]);
    // ...the cleanup is pending again and not yet claimed as done...
    expect(unwrittenOutboxRemovals()).toBe(1);
    expect(device.values.get(OUTBOX_STORAGE_KEY)).toContain("private words");
    expect(device.values.has(OUTBOX_REMOVED_STORAGE_KEY)).toBe(true);

    // ...and the retry rewrites the filtered queue, then clears the mark.
    vi.advanceTimersByTime(500);
    expect(queueIds(device.values)).toEqual(["keep"]);
    expect(device.values.get(OUTBOX_STORAGE_KEY)).not.toContain("private words");
    expect(unwrittenOutboxRemovals()).toBe(0);
    expect(device.values.has(OUTBOX_REMOVED_STORAGE_KEY)).toBe(false);

    // A third page has nothing left to do.
    const writes = device.calls.get(OUTBOX_STORAGE_KEY);
    resetOutboxForTesting(device.storage);
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["keep"]);
    vi.advanceTimersByTime(120_000);
    expect(device.calls.get(OUTBOX_STORAGE_KEY)).toBe(writes);
  });

  it("after a reload the mark stays until the rewrite lands, retrying while the device refuses", () => {
    vi.useFakeTimers();
    let open = false;
    const device = flakyStorage(
      (key, call) => key === OUTBOX_STORAGE_KEY && (call === 3 || (call > 3 && !open)),
    );
    resetOutboxForTesting(device.storage);
    enqueueOutboxEntry(entry("keep"));
    enqueueOutboxEntry(entry("cancel me", "t1", { text: "private words" }));
    removeOutboxEntry("cancel me");

    resetOutboxForTesting(device.storage); // reload, device still refuses the queue key
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["keep"]);
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(2_000);
    expect(unwrittenOutboxRemovals()).toBe(1);
    expect(device.values.has(OUTBOX_REMOVED_STORAGE_KEY)).toBe(true);
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["keep"]);

    open = true;
    vi.advanceTimersByTime(8_000);
    expect(device.values.get(OUTBOX_STORAGE_KEY)).not.toContain("private words");
    expect(unwrittenOutboxRemovals()).toBe(0);
    expect(device.values.has(OUTBOX_REMOVED_STORAGE_KEY)).toBe(false);
  });

  it("ignores a damaged removed-ids key", () => {
    const device = flakyStorage(() => false);
    device.values.set(OUTBOX_REMOVED_STORAGE_KEY, "{not json");
    resetOutboxForTesting(device.storage);
    enqueueOutboxEntry(entry("a"));
    expect(getOutboxSnapshot().entries.map((item) => item.id)).toEqual(["a"]);
  });
});
