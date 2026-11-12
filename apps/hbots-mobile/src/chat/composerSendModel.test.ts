import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DraftAttachment } from "./outboxNative";
import {
  ACK_CONNECTION_CHECK_MS,
  ACK_TIMEOUT_MS,
  EMPTY_DRAFT,
  MAX_STORED_OUTGOING,
  OUTGOING_INDEX_KEY,
  addStoredOutgoing,
  awaitAck,
  beginSend,
  forgetOutgoingKey,
  hasDraftContent,
  mergePending,
  outgoingFromStored,
  outgoingStorageKey,
  parseOutgoingIndex,
  parseStoredOutgoing,
  pendingSend,
  rememberOutgoingKey,
  removePending,
  removeStoredOutgoing,
  restoreDraft,
  retrySend,
  sendMetaFromStored,
  settle,
  wipeOutgoingThread,
} from "./composerSendModel";

const photo: DraftAttachment = {
  id: "photo-1",
  kind: "image",
  name: "photo.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 2048,
  uri: "file:///photo.jpg",
};

const createdAt = "2026-11-12T10:00:00.000Z";

function outgoingOf(text = "Hello", attachments: ReadonlyArray<DraftAttachment> = [photo]) {
  return beginSend({ text, attachments }, "message-1", createdAt).outgoing;
}

describe("beginSend", () => {
  it("empties the draft during a send that never resolves", () => {
    const { draft, outgoing } = beginSend(
      { text: "Hello", attachments: [photo] },
      "message-1",
      createdAt,
    );
    expect(draft).toEqual(EMPTY_DRAFT);
    expect(hasDraftContent(draft)).toBe(false);
    expect(outgoing).toEqual({
      id: "message-1",
      text: "Hello",
      attachments: [photo],
      createdAt,
      state: "sending",
    });
    expect(hasDraftContent({ text: "Second", attachments: [] })).toBe(true);
  });
});

describe("settle", () => {
  it("marks a failed send without touching its text", () => {
    const outgoing = outgoingOf();
    const failed = settle(outgoing, { ok: false });
    expect(failed.state).toBe("failed");
    expect(failed.text).toBe("Hello");
    expect(failed.attachments).toEqual([photo]);
  });

  it("leaves a landed send alone", () => {
    const outgoing = outgoingOf();
    expect(settle(outgoing, { ok: true })).toEqual(outgoing);
  });
});

describe("restoreDraft", () => {
  it("puts a refused text back into an empty field", () => {
    const failed = settle(outgoingOf(), { ok: false });
    expect(restoreDraft(failed, EMPTY_DRAFT)).toEqual({ text: "Hello", attachments: [photo] });
  });

  it("puts the refused text in front of text typed since", () => {
    const failed = settle(outgoingOf("Hello", []), { ok: false });
    expect(restoreDraft(failed, { text: "Second", attachments: [] })).toEqual({
      text: "Hello\n\nSecond",
      attachments: [],
    });
  });

  it("leaves the field alone when the send succeeds", () => {
    const outgoing = outgoingOf("Hello", []);
    const draft = { text: "Second", attachments: [] };
    expect(settle(outgoing, { ok: true })).toBe(outgoing);
    expect(draft).toEqual({ text: "Second", attachments: [] });
  });
});

describe("awaitAck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles a send that answers before the deadline", async () => {
    const end = awaitAck(
      Promise.resolve("Success"),
      () => ({ kind: "sent" }),
      () => false,
    );
    expect(await end).toEqual({ kind: "sent" });
  });

  it("times out at 45 s with the text kept", async () => {
    const failed = settle(outgoingOf(), { ok: false });
    const end = awaitAck(
      new Promise<never>(() => undefined),
      () => ({ kind: "sent" }),
      () => false,
    );
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    expect(await end).toEqual({ kind: "timeout" });
    expect(failed.state).toBe("failed");
    expect(failed.text).toBe("Hello");
    expect(failed.attachments).toEqual([photo]);
  });

  it("ends a send whose connection drops", async () => {
    let connected = true;
    const end = awaitAck(
      new Promise<never>(() => undefined),
      () => ({ kind: "sent" }),
      () => !connected,
    );
    connected = false;
    await vi.advanceTimersByTimeAsync(ACK_CONNECTION_CHECK_MS);
    expect(await end).toEqual({ kind: "disconnected" });
    expect(settle(outgoingOf(), { ok: false }).state).toBe("failed");
  });

  it("clears the ack timer when the chat screen goes away", async () => {
    const abort = new AbortController();
    const end = awaitAck(
      new Promise<never>(() => undefined),
      () => ({ kind: "sent" }),
      () => false,
      abort.signal,
    );
    expect(vi.getTimerCount()).toBe(2);

    abort.abort();

    expect(await end).toEqual({ kind: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    expect(await end).toEqual({ kind: "cancelled" });
  });
});

describe("retry and persistence", () => {
  it("keeps the same message id on retry", () => {
    const failed = settle(outgoingOf(), { ok: false });
    const retried = retrySend(failed);
    expect(retried.id).toBe(failed.id);
    expect(retried.state).toBe("sending");
    expect(retried.text).toBe("Hello");
  });

  it("clears a failed entry when the late success arrives, without duplicating it", () => {
    const failed = settle(outgoingOf(), { ok: false });
    const once = addStoredOutgoing(null, failed);
    const twice = addStoredOutgoing(once, failed);
    expect(parseStoredOutgoing(twice)).toHaveLength(1);
    const cleared = removeStoredOutgoing(twice, failed.id);
    expect(cleared).toBeNull();
    const pending = [pendingSend(failed, "thread-1", "Hello")];
    expect(removePending(pending, failed.id)).toEqual([]);
  });

  it("restores a failed bubble after a reload", () => {
    const failed = settle(outgoingOf(), { ok: false });
    const stored = parseStoredOutgoing(addStoredOutgoing(null, failed));
    expect(stored).toHaveLength(1);
    const restored = outgoingFromStored(stored[0]!);
    expect(restored).toEqual(failed);
    const pending = pendingSend(restored, "thread-1", "Hello");
    expect(pending.state).toBe("failed");
    expect(pending.text).toBe("Hello");
    expect(mergePending([], [pending])).toEqual([pending]);
  });

  it("keeps a restored send's quote and follow-up so a refused retry restores the text", () => {
    const quote = { messageId: "message-0", name: "Bot", excerpt: "Earlier" };
    const meta = { followUp: "queue" as const, quote, clearDraftAfter: true };
    const failed = settle(outgoingOf(), { ok: false });
    const stored = parseStoredOutgoing(addStoredOutgoing(null, failed, meta));

    expect(stored).toHaveLength(1);
    expect(sendMetaFromStored(stored[0]!)).toEqual(meta);
    const restored = outgoingFromStored(stored[0]!);
    expect(restoreDraft(settle(restored, { ok: false }), EMPTY_DRAFT)).toEqual({
      text: "Hello",
      attachments: [photo],
    });
  });

  it("keeps at most 20 failed sends per chat, dropping the oldest", () => {
    let raw: string | null = null;
    for (let index = 0; index < MAX_STORED_OUTGOING + 1; index += 1) {
      const outgoing = beginSend(
        { text: `Message ${index}`, attachments: [] },
        `message-${index}`,
        createdAt,
      ).outgoing;
      raw = addStoredOutgoing(raw, outgoing);
    }

    const stored = parseStoredOutgoing(raw);

    expect(stored).toHaveLength(MAX_STORED_OUTGOING);
    expect(stored[0]?.id).toBe("message-1");
    expect(stored.at(-1)?.id).toBe(`message-${MAX_STORED_OUTGOING}`);
  });
});

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("the saved sends index", () => {
  it("lists a chat's key so a sign-out can find it, and forgets it when the entry goes", () => {
    const key = outgoingStorageKey("environment-phone", "thread-1");

    expect(parseOutgoingIndex(rememberOutgoingKey(null, key))).toEqual([key]);
    expect(forgetOutgoingKey(JSON.stringify([key]), key)).toBeNull();
  });

  it("removes a deleted thread's saved sends and returns their message ids", () => {
    const store = memoryStore();
    const key = outgoingStorageKey("environment-phone", "thread-1");
    store.setItem(key, addStoredOutgoing(null, outgoingOf()));
    store.setItem(OUTGOING_INDEX_KEY, rememberOutgoingKey(null, key));

    expect(wipeOutgoingThread(store, "environment-phone", "thread-1")).toEqual(["message-1"]);
    expect(store.getItem(key)).toBeNull();
    expect(parseOutgoingIndex(store.getItem(OUTGOING_INDEX_KEY))).toEqual([]);
  });
});
