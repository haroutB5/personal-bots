import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  enqueueOutboxEntry,
  getOutboxSnapshot,
  markOutboxFailed,
  type NewOutboxEntry,
  type OutboxEntry,
  type OutboxStorage,
  resetOutboxForTesting,
  retryOutboxEntry,
} from "./outbox.ts";
import {
  classifySendFailure,
  createOutboxFlusher,
  OUTBOX_CONNECTION_CHECK_MS,
  OUTBOX_MAX_UNANSWERED,
  OUTBOX_SEND_TIMEOUT_MS,
  runOutboxPass,
  type SendOutcome,
} from "./outboxFlush.ts";

function memoryStorage(): OutboxStorage {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
}

function entry(id: string, threadId = "t1"): NewOutboxEntry {
  return {
    id,
    kind: "turn",
    environmentId: "env",
    threadId,
    groupId: null,
    text: id,
    sendText: id,
    createdAt: "2026-10-08T12:00:00.000Z",
    replyTo: null,
    turn: null,
    attachments: [],
  };
}

const ids = () => getOutboxSnapshot().entries.map((item) => item.id);

beforeEach(() => resetOutboxForTesting(memoryStorage()));
afterEach(() => resetOutboxForTesting(undefined));

describe("classifySendFailure", () => {
  it("a send the client refused before it left is 'not sent'", () => {
    expect(classifySendFailure({ _tag: "EnvironmentRpcUnavailableError", message: "x" })).toEqual({
      kind: "not-sent",
    });
    expect(classifySendFailure({ _tag: "EnvironmentNotRegisteredError" })).toEqual({
      kind: "not-sent",
    });
  });

  it("only an answer from the laptop counts as a refusal, and it reads 'Couldn't send: ...'", () => {
    const refused = classifySendFailure({
      _tag: "OrchestrationDispatchCommandError",
      message: "Thread 't1' is deleted and cannot start a turn.",
    });
    expect(refused.kind).toBe("rejected");
    expect(refused.kind === "rejected" ? refused.message : "").toMatch(/^Couldn't send: /);
    expect(classifySendFailure({ _tag: "PersonalGroupsError", message: "No members." }).kind).toBe(
      "rejected",
    );
  });

  it("a dropped connection, a timeout or anything unrecognised may have landed", () => {
    expect(classifySendFailure({ _tag: "RpcClientError", message: "socket closed" })).toEqual({
      kind: "unknown",
    });
    expect(classifySendFailure(new Error("network down"))).toEqual({ kind: "unknown" });
    expect(classifySendFailure(undefined)).toEqual({ kind: "unknown" });
    expect(classifySendFailure("boom")).toEqual({ kind: "unknown" });
  });
});

describe("one pass over the queue", () => {
  it("sends several queued messages in the order they were typed, each once", async () => {
    enqueueOutboxEntry(entry("one"));
    enqueueOutboxEntry(entry("two", "t2"));
    enqueueOutboxEntry(entry("three"));
    const sent: string[] = [];
    const result = await runOutboxPass({
      environmentId: "env",
      isConnected: () => true,
      send: async (item) => {
        sent.push(item.id);
        return { kind: "sent" };
      },
    });
    expect(sent).toEqual(["one", "two", "three"]);
    expect(ids()).toEqual([]);
    expect(result.retryInMs).toBeNull();
  });

  it("does nothing while the laptop is not connected", async () => {
    enqueueOutboxEntry(entry("one"));
    const send = vi.fn();
    await runOutboxPass({ environmentId: "env", isConnected: () => false, send });
    expect(send).not.toHaveBeenCalled();
    expect(ids()).toEqual(["one"]);
  });

  it("leaves another laptop's messages alone", async () => {
    enqueueOutboxEntry({ ...entry("elsewhere"), environmentId: "other" });
    const send = vi.fn();
    await runOutboxPass({ environmentId: "env", isConnected: () => true, send });
    expect(send).not.toHaveBeenCalled();
  });

  it("stops at a message that never left the device and asks to be run again soon", async () => {
    enqueueOutboxEntry(entry("one"));
    enqueueOutboxEntry(entry("two"));
    const sent: string[] = [];
    const result = await runOutboxPass({
      environmentId: "env",
      isConnected: () => true,
      send: async (item) => {
        sent.push(item.id);
        return { kind: "not-sent" };
      },
    });
    // The second message of the same chat did not overtake the first.
    expect(sent).toEqual(["one"]);
    expect(ids()).toEqual(["one", "two"]);
    expect(result.retryInMs).not.toBeNull();
    // Not being connected is not the message's fault: nothing is counted against it.
    expect(getOutboxSnapshot().entries[0]?.attempts).toBe(0);
  });

  it("a message dropped mid-send is resent under the same ids, and counts one unanswered attempt", async () => {
    enqueueOutboxEntry(entry("one"));
    const seen: Array<{ id: string; commandId: string; createdAt: string }> = [];
    const outcomes: SendOutcome[] = [{ kind: "unknown" }, { kind: "sent" }];
    const send = async (item: OutboxEntry): Promise<SendOutcome> => {
      seen.push({ id: item.id, commandId: item.commandId, createdAt: item.createdAt });
      return outcomes.shift() ?? { kind: "sent" };
    };
    const first = await runOutboxPass({ environmentId: "env", isConnected: () => true, send });
    expect(first.retryInMs).not.toBeNull();
    expect(getOutboxSnapshot().entries[0]?.attempts).toBe(1);
    await runOutboxPass({ environmentId: "env", isConnected: () => true, send });
    expect(ids()).toEqual([]);
    // Both attempts carried the very same message id, command id and time: the
    // server answers the second from its receipt of the first.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
  });

  it(`gives up after ${OUTBOX_MAX_UNANSWERED} unanswered attempts: the message stays, failed, with Retry`, async () => {
    enqueueOutboxEntry(entry("one"));
    enqueueOutboxEntry(entry("two"));
    const send = vi.fn(async (): Promise<SendOutcome> => ({ kind: "unknown" }));
    for (let pass = 0; pass < OUTBOX_MAX_UNANSWERED; pass += 1) {
      await runOutboxPass({ environmentId: "env", isConnected: () => true, send });
    }
    const [one, two] = getOutboxSnapshot().entries;
    expect(one?.status).toBe("failed");
    expect(one?.error).toMatch(/^Couldn't send: /);
    expect(one?.rejected).toBe(false);
    expect(two?.status).toBe("waiting");
    expect(send).toHaveBeenCalledTimes(OUTBOX_MAX_UNANSWERED);
    // Retry keeps the command id (the first attempt may have landed) and tries again.
    const id = one?.commandId;
    retryOutboxEntry("one");
    expect(getOutboxSnapshot().entries[0]).toMatchObject({ status: "waiting", commandId: id });
  });

  it("a refused message is marked failed and holds back its own chat only", async () => {
    enqueueOutboxEntry(entry("refused", "t1"));
    enqueueOutboxEntry(entry("behind-it", "t1"));
    enqueueOutboxEntry(entry("other-chat", "t2"));
    const sent: string[] = [];
    await runOutboxPass({
      environmentId: "env",
      isConnected: () => true,
      send: async (item) => {
        sent.push(item.id);
        return item.id === "refused"
          ? { kind: "rejected", message: "Couldn't send: that chat is gone." }
          : { kind: "sent" };
      },
    });
    expect(sent).toEqual(["refused", "other-chat"]);
    expect(ids()).toEqual(["refused", "behind-it"]);
    expect(getOutboxSnapshot().entries[0]).toMatchObject({
      status: "failed",
      rejected: true,
      error: "Couldn't send: that chat is gone.",
    });
    // A later pass skips the failed message and everything typed after it in that chat.
    const again = vi.fn(async (): Promise<SendOutcome> => ({ kind: "sent" }));
    await runOutboxPass({ environmentId: "env", isConnected: () => true, send: again });
    expect(again).not.toHaveBeenCalled();
  });

  it("Retry on a refused message sends it again under a new command id, in its old place", async () => {
    enqueueOutboxEntry(entry("refused"));
    enqueueOutboxEntry(entry("behind-it"));
    markOutboxFailed("refused", "Couldn't send: nope.", true);
    retryOutboxEntry("refused");
    const seen: string[] = [];
    await runOutboxPass({
      environmentId: "env",
      isConnected: () => true,
      send: async (item) => {
        seen.push(`${item.id}/${item.commandId}`);
        return { kind: "sent" };
      },
    });
    expect(seen).toEqual(["refused/outbox:refused:2", "behind-it/outbox:behind-it"]);
  });

  it("a send that throws counts as unanswered, never as lost", async () => {
    enqueueOutboxEntry(entry("one"));
    await runOutboxPass({
      environmentId: "env",
      isConnected: () => true,
      send: async () => {
        throw new Error("socket closed");
      },
    });
    expect(ids()).toEqual(["one"]);
    expect(getOutboxSnapshot().entries[0]?.attempts).toBe(1);
  });

  it("a message cancelled while an earlier one is in flight is not sent", async () => {
    enqueueOutboxEntry(entry("one"));
    enqueueOutboxEntry(entry("two"));
    const { removeOutboxEntry } = await import("./outbox.ts");
    const sent: string[] = [];
    await runOutboxPass({
      environmentId: "env",
      isConnected: () => true,
      send: async (item) => {
        sent.push(item.id);
        removeOutboxEntry("two");
        return { kind: "sent" };
      },
    });
    expect(sent).toEqual(["one"]);
    expect(ids()).toEqual([]);
  });
});

describe("a send cut off by the connection going away", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("goes out again on the new connection, not at the send timeout", async () => {
    enqueueOutboxEntry(entry("one"));
    let generation = 0;
    let connected = true;
    const sends: string[] = [];
    const flusher = createOutboxFlusher({
      environmentId: "env",
      isConnected: () => connected,
      connectionGeneration: () => generation,
      send: (item) => {
        sends.push(item.id);
        return sends.length === 1
          ? new Promise<SendOutcome>(() => {})
          : Promise.resolve({ kind: "sent" });
      },
    });
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toEqual(["one"]);

    // The phone drops the network with the send in flight, then connects again.
    connected = false;
    await vi.advanceTimersByTimeAsync(1_000);
    generation += 1;
    connected = true;
    flusher.trigger();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sends).toEqual(["one", "one"]);
    expect(ids()).toEqual([]);
    flusher.dispose();
  });

  it("does not count an attempt whose socket was replaced before it answered", async () => {
    enqueueOutboxEntry(entry("one"));
    let generation = 0;
    let connected = true;
    const result = await runOutboxPass({
      environmentId: "env",
      isConnected: () => connected,
      connectionGeneration: () => generation,
      send: async () => {
        // The socket died under the send, and the replacement is already in
        // place before the rejection reaches the queue.
        connected = false;
        generation += 1;
        return { kind: "unknown" };
      },
    });
    expect(getOutboxSnapshot().entries[0]).toMatchObject({
      status: "waiting",
      attempts: 0,
    });
    // The pass stops; the next connection starts it again.
    expect(result.retryInMs).toBeNull();
  });

  it("never gives up on a message through any number of replaced sockets", async () => {
    enqueueOutboxEntry(entry("one"));
    let generation = 0;
    let connected = true;
    const send = vi.fn(async (): Promise<SendOutcome> => {
      connected = false;
      generation += 1;
      return { kind: "unknown" };
    });
    const flusher = createOutboxFlusher({
      environmentId: "env",
      isConnected: () => connected,
      connectionGeneration: () => generation,
      send,
    });
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);

    for (let cycle = 0; cycle < 8; cycle += 1) {
      connected = true;
      flusher.trigger();
      await vi.advanceTimersByTimeAsync(200);
    }

    expect(getOutboxSnapshot().entries[0]).toMatchObject({
      status: "waiting",
      attempts: 0,
      error: null,
    });
    flusher.dispose();
  });

  it("does not use up the message's unanswered attempts, however often the network drops", async () => {
    enqueueOutboxEntry(entry("one"));
    let generation = 0;
    let connected = true;
    const send = vi.fn((): Promise<SendOutcome> => new Promise(() => {}));
    const flusher = createOutboxFlusher({
      environmentId: "env",
      isConnected: () => connected,
      connectionGeneration: () => generation,
      send,
    });
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      connected = false;
      await vi.advanceTimersByTimeAsync(500);
      generation += 1;
      connected = true;
      flusher.trigger();
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(send).toHaveBeenCalledTimes(6);
    expect(getOutboxSnapshot().entries[0]).toMatchObject({
      status: "waiting",
      attempts: 0,
    });
    flusher.dispose();
  });
});

describe("a send that never answers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is counted as unanswered after the timeout and does not hold up another chat", async () => {
    enqueueOutboxEntry(entry("hung", "t1"));
    enqueueOutboxEntry(entry("fine", "t2"));
    const sent: string[] = [];
    const pass = runOutboxPass({
      environmentId: "env",
      isConnected: () => true,
      send: (item) => {
        sent.push(item.id);
        return item.id === "hung"
          ? new Promise<SendOutcome>(() => {})
          : Promise.resolve({ kind: "sent" });
      },
    });
    await vi.advanceTimersByTimeAsync(OUTBOX_SEND_TIMEOUT_MS + OUTBOX_CONNECTION_CHECK_MS);
    const result = await pass;
    expect(sent).toEqual(["hung", "fine"]);
    expect(ids()).toEqual(["hung"]);
    expect(getOutboxSnapshot().entries[0]).toMatchObject({ attempts: 1, status: "waiting" });
    expect(getOutboxSnapshot().sending.size).toBe(0);
    expect(result.retryInMs).not.toBeNull();
  });
});

describe("the flusher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("an unanswered head stays failed across triggers and revives only on a new connection", async () => {
    enqueueOutboxEntry(entry("one"));
    enqueueOutboxEntry(entry("two"));
    markOutboxFailed("one", "Couldn't send: your laptop didn't answer. Try again.", false);
    const send = vi.fn(async (_item: OutboxEntry): Promise<SendOutcome> => ({ kind: "sent" }));
    let connected = true;
    let generation = 0;
    const flusher = createOutboxFlusher({
      environmentId: "env",
      isConnected: () => connected,
      connectionGeneration: () => generation,
      send,
    });
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);
    // A cold start with a failed entry waits for Retry or a new connection.
    expect(send).not.toHaveBeenCalled();
    for (let cycle = 0; cycle < 10; cycle += 1) {
      flusher.trigger();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(send).not.toHaveBeenCalled();
    expect(getOutboxSnapshot().entries.map((item) => [item.id, item.status])).toEqual([
      ["one", "failed"],
      ["two", "waiting"],
    ]);

    connected = false;
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);
    connected = true;
    generation += 1;
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(send.mock.calls.map((call) => (call[0] as OutboxEntry).id)).toEqual(["one", "two"]);
    expect(ids()).toEqual([]);
    flusher.dispose();
  });

  it("a refusal stays failed across triggers and reconnects until Retry", async () => {
    enqueueOutboxEntry(entry("one"));
    enqueueOutboxEntry(entry("two"));
    markOutboxFailed("one", "Couldn't send: an attachment didn't upload. Try again.", true);
    const send = vi.fn(async (_item: OutboxEntry): Promise<SendOutcome> => ({ kind: "sent" }));
    let connected = true;
    let generation = 0;
    const flusher = createOutboxFlusher({
      environmentId: "env",
      isConnected: () => connected,
      connectionGeneration: () => generation,
      send,
    });
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      flusher.trigger();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    connected = false;
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);
    connected = true;
    generation += 1;
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(send).not.toHaveBeenCalled();
    expect(getOutboxSnapshot().entries.map((item) => [item.id, item.status])).toEqual([
      ["one", "failed"],
      ["two", "waiting"],
    ]);

    retryOutboxEntry("one");
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send.mock.calls.map((call) => (call[0] as OutboxEntry).id)).toEqual(["one", "two"]);
    expect(ids()).toEqual([]);
    flusher.dispose();
  });

  it("a page with no socket counter revives an unanswered head on the connection edge", async () => {
    enqueueOutboxEntry(entry("one"));
    enqueueOutboxEntry(entry("two"));
    markOutboxFailed("one", "Couldn't send: your laptop didn't answer. Try again.", false);
    const send = vi.fn(async (_item: OutboxEntry): Promise<SendOutcome> => ({ kind: "sent" }));
    let connected = true;
    const flusher = createOutboxFlusher({
      environmentId: "env",
      isConnected: () => connected,
      send,
    });
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).not.toHaveBeenCalled();

    connected = false;
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);
    connected = true;
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(send.mock.calls.map((call) => (call[0] as OutboxEntry).id)).toEqual(["one", "two"]);
    flusher.dispose();
  });

  it("a head the laptop refused stays failed until Retry", async () => {
    enqueueOutboxEntry(entry("one"));
    enqueueOutboxEntry(entry("two"));
    markOutboxFailed("one", "Couldn't send: that chat is gone.", true);
    const send = vi.fn(async (_item: OutboxEntry): Promise<SendOutcome> => ({ kind: "sent" }));
    const flusher = createOutboxFlusher({
      environmentId: "env",
      isConnected: () => true,
      send,
    });
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    expect(getOutboxSnapshot().entries[0]).toMatchObject({ status: "failed", rejected: true });
    flusher.dispose();
  });

  it("picks up a message queued while a pass is running", async () => {
    enqueueOutboxEntry(entry("one"));
    const sent: string[] = [];
    let release!: () => void;
    const flusher = createOutboxFlusher({
      environmentId: "env",
      isConnected: () => true,
      send: async (item) => {
        sent.push(item.id);
        if (item.id === "one") await new Promise<void>((resolve) => (release = resolve));
        return { kind: "sent" };
      },
    });
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);
    enqueueOutboxEntry(entry("two"));
    flusher.trigger();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["one", "two"]);
    expect(ids()).toEqual([]);
    flusher.dispose();
  });

  it("two triggers at once start one pass, so a message is never in flight twice", async () => {
    enqueueOutboxEntry(entry("one"));
    let inFlight = 0;
    let peak = 0;
    const flusher = createOutboxFlusher({
      environmentId: "env",
      isConnected: () => true,
      send: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { kind: "sent" };
      },
    });
    flusher.trigger();
    flusher.trigger();
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(peak).toBe(1);
    flusher.dispose();
  });

  it("comes back by itself after an unanswered attempt, while still connected", async () => {
    enqueueOutboxEntry(entry("one"));
    const outcomes: SendOutcome[] = [{ kind: "unknown" }, { kind: "sent" }];
    const flusher = createOutboxFlusher({
      environmentId: "env",
      isConnected: () => true,
      send: async () => outcomes.shift() ?? { kind: "sent" },
    });
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(ids()).toEqual(["one"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ids()).toEqual([]);
    flusher.dispose();
  });

  it("does not come back once the connection is gone", async () => {
    enqueueOutboxEntry(entry("one"));
    let connected = true;
    const send = vi.fn(async (): Promise<SendOutcome> => {
      connected = false;
      return { kind: "unknown" };
    });
    const flusher = createOutboxFlusher({
      environmentId: "env",
      isConnected: () => connected,
      send,
    });
    flusher.trigger();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    flusher.dispose();
  });
});
