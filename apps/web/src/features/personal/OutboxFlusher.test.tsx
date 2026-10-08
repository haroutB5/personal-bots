import * as Cause from "effect/Cause";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  enqueueOutboxEntry,
  getOutboxSnapshot,
  type NewOutboxEntry,
  type OutboxStorage,
  resetOutboxForTesting,
} from "./outbox";
import { setOutboxBlobBackendForTesting } from "./outboxBlobs";
import { OutboxFlusher } from "./OutboxFlusher";

const mocks = vi.hoisted(() => ({
  phase: "connected" as string,
  startTurn: vi.fn(),
  groupSend: vi.fn(),
  startUpload: vi.fn(),
  waitUploads: vi.fn(),
  uploaded: vi.fn(),
  release: vi.fn(),
}));

vi.mock("./PersonalOfflineBanner", () => ({ usePersonalConnectionPhase: () => mocks.phase }));
vi.mock("./usePersonalBots", () => ({ usePersonalEnvironmentId: () => "env" }));
vi.mock("./usePersonalGroups", () => ({ personalGroupSendMessage: "group-send" }));
vi.mock("~/state/threads", () => ({ threadEnvironment: { startTurn: "start-turn" } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "start-turn"
      ? mocks.startTurn
      : command === "group-send"
        ? mocks.groupSend
        : vi.fn(),
}));
vi.mock("~/lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: (input: unknown) => mocks.startUpload(input),
  awaitAttachmentUploads: () => mocks.waitUploads(),
  getUploadedAttachments: (input: unknown) => mocks.uploaded(input),
  releaseDraftAttachment: (value: unknown) => mocks.release(value),
}));

function memoryStorage(): OutboxStorage {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_key, next) => (value = next) };
}

const turn = {
  modelSelection: { instanceId: "claude", model: "sonnet" },
  titleSeed: "hello",
  runtimeMode: "full-access",
  interactionMode: "default",
} as never;

function entry(id: string, extra: Partial<NewOutboxEntry> = {}): NewOutboxEntry {
  return {
    id,
    kind: "turn",
    environmentId: "env",
    threadId: "t1",
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

const refusal = (message: string) => ({
  _tag: "Failure",
  cause: Cause.fail({ _tag: "OrchestrationDispatchCommandError", message }),
});

let renderer: ReactTestRenderer;
const mount = async () => {
  await act(async () => {
    renderer = create(<OutboxFlusher />);
  });
};
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const ids = () => getOutboxSnapshot().entries.map((item) => item.id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetOutboxForTesting(memoryStorage());
  mocks.phase = "connected";
  mocks.startTurn.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.groupSend.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.startUpload.mockReset();
  mocks.waitUploads.mockReset().mockResolvedValue(undefined);
  mocks.uploaded.mockReset();
  mocks.release.mockReset();
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetOutboxForTesting(undefined);
  setOutboxBlobBackendForTesting();
});

describe("sending the queue", () => {
  it("sends every queued message once the laptop is connected, oldest first, with its saved ids", async () => {
    enqueueOutboxEntry(
      entry("a", { replyTo: { messageId: "bot-1", name: "Mori", excerpt: "All green." } }),
    );
    enqueueOutboxEntry(entry("b"));
    enqueueOutboxEntry(entry("c", { threadId: "t2" }));
    await mount();
    await settle();
    expect(mocks.startTurn).toHaveBeenCalledTimes(3);
    const inputs = mocks.startTurn.mock.calls.map((call) => call[0].input);
    expect(inputs.map((input) => input.message.messageId)).toEqual(["a", "b", "c"]);
    expect(inputs.map((input) => input.commandId)).toEqual(["outbox:a", "outbox:b", "outbox:c"]);
    expect(inputs[0]).toMatchObject({
      threadId: "t1",
      createdAt: "2026-10-08T12:00:00.000Z",
      titleSeed: "hello",
      runtimeMode: "full-access",
      interactionMode: "default",
      modelSelection: { instanceId: "claude", model: "sonnet" },
      message: { role: "user", text: "text a", attachments: [] },
    });
    // A reply carries its quote; a plain message carries none.
    expect(inputs[0].message.context).toBeDefined();
    expect(inputs[1].message).not.toHaveProperty("context");
    expect(mocks.startTurn.mock.calls[0]?.[0].environmentId).toBe("env");
    expect(ids()).toEqual([]);
  });

  it("waits while the laptop is away, and sends when it comes back", async () => {
    mocks.phase = "reconnecting";
    enqueueOutboxEntry(entry("a"));
    await mount();
    await settle();
    expect(mocks.startTurn).not.toHaveBeenCalled();
    expect(ids()).toEqual(["a"]);
    mocks.phase = "connected";
    await act(async () => renderer.update(<OutboxFlusher />));
    await settle();
    expect(mocks.startTurn).toHaveBeenCalledOnce();
    expect(ids()).toEqual([]);
  });

  it("sends a message typed while it is connected, behind nothing", async () => {
    await mount();
    await settle();
    expect(mocks.startTurn).not.toHaveBeenCalled();
    await act(async () => void enqueueOutboxEntry(entry("late")));
    await settle();
    expect(mocks.startTurn).toHaveBeenCalledOnce();
  });

  it("a send that dropped mid-way is sent again under the very same ids, and arrives once", async () => {
    enqueueOutboxEntry(entry("a"));
    mocks.startTurn
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValue({ _tag: "Success" });
    await mount();
    await settle();
    expect(ids()).toEqual(["a"]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(2_000)));
    expect(mocks.startTurn).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.startTurn.mock.calls.map((call) => call[0].input);
    expect(second.commandId).toBe(first.commandId);
    expect(second.message.messageId).toBe(first.message.messageId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(ids()).toEqual([]);
  });

  it("a message not yet sent when the laptop drops waits, and is not counted against", async () => {
    enqueueOutboxEntry(entry("a"));
    mocks.startTurn.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail({ _tag: "EnvironmentRpcUnavailableError", message: "not connected" }),
    });
    await mount();
    await settle();
    expect(ids()).toEqual(["a"]);
    expect(getOutboxSnapshot().entries[0]?.attempts).toBe(0);
    expect(getOutboxSnapshot().entries[0]?.status).toBe("waiting");
  });

  it("a refusal fails that message with the reason and holds back the chat's later ones", async () => {
    enqueueOutboxEntry(entry("a"));
    enqueueOutboxEntry(entry("b"));
    enqueueOutboxEntry(entry("c", { threadId: "t2" }));
    mocks.startTurn.mockImplementation(
      async (call: { input: { message: { messageId: string } } }) =>
        call.input.message.messageId === "a"
          ? refusal("Thread 't1' is deleted.")
          : { _tag: "Success" },
    );
    await mount();
    await settle();
    expect(mocks.startTurn.mock.calls.map((call) => call[0].input.message.messageId)).toEqual([
      "a",
      "c",
    ]);
    expect(getOutboxSnapshot().entries.map((item) => [item.id, item.status])).toEqual([
      ["a", "failed"],
      ["b", "waiting"],
    ]);
    expect(getOutboxSnapshot().entries[0]?.error).toMatch(/^Couldn't send: /);
  });

  it("sends a group message to the group, by message id", async () => {
    enqueueOutboxEntry(
      entry("g1", {
        kind: "group",
        groupId: "group-1",
        turn: null,
        text: "hi all",
        sendText: "hi all",
      }),
    );
    await mount();
    await settle();
    expect(mocks.startTurn).not.toHaveBeenCalled();
    expect(mocks.groupSend).toHaveBeenCalledOnce();
    expect(mocks.groupSend.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env",
      input: { groupId: "group-1", messageId: "g1", text: "hi all" },
    });
    expect(mocks.groupSend.mock.calls[0]?.[0].input).not.toHaveProperty("replyTo");
    expect(ids()).toEqual([]);
  });

  it("uploads a queued photo or file from the bytes on the device, then sends the message with it", async () => {
    const stored = new Map<string, Blob>([
      ["p1/att-1", new Blob(["bytes"], { type: "text/plain" })],
    ]);
    setOutboxBlobBackendForTesting({
      put: async () => {},
      get: async (key) => stored.get(key) ?? null,
      deletePrefix: async (prefix) => {
        for (const key of [...stored.keys()]) if (key.startsWith(prefix)) stored.delete(key);
      },
      keys: async () => [...stored.keys()],
    });
    enqueueOutboxEntry(
      entry("p1", {
        text: "",
        sendText: "[attached]",
        attachments: [
          { id: "att-1", kind: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 5 },
        ],
      }),
    );
    mocks.uploaded.mockReturnValue([{ type: "file", id: "server-att-1", name: "notes.txt" }]);
    await mount();
    await settle();
    expect(mocks.startUpload).toHaveBeenCalledOnce();
    expect(mocks.startUpload.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env",
      image: { type: "file", id: "att-1", name: "notes.txt", sizeBytes: 5 },
    });
    expect(mocks.startUpload.mock.calls[0]?.[0].image.file).toBeInstanceOf(File);
    expect(mocks.startTurn.mock.calls[0]?.[0].input.message).toMatchObject({
      text: "[attached]",
      attachments: [{ type: "file", id: "server-att-1", name: "notes.txt" }],
    });
    expect(mocks.release).toHaveBeenCalledOnce();
    // Sent: the message and its bytes are gone from the device.
    expect(ids()).toEqual([]);
    expect([...stored.keys()]).toEqual([]);
  });

  it("an attachment that no longer exists on the device fails the message with a clear reason", async () => {
    setOutboxBlobBackendForTesting({
      put: async () => {},
      get: async () => null,
      deletePrefix: async () => {},
      keys: async () => [],
    });
    enqueueOutboxEntry(
      entry("p1", {
        attachments: [
          { id: "att-1", kind: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 5 },
        ],
      }),
    );
    await mount();
    await settle();
    expect(mocks.startTurn).not.toHaveBeenCalled();
    expect(getOutboxSnapshot().entries[0]).toMatchObject({ status: "failed", rejected: true });
    expect(getOutboxSnapshot().entries[0]?.error).toMatch(/^Couldn't send: an attachment/);
  });

  it("an upload that does not finish is unanswered, not lost: it is tried again with the same ids", async () => {
    setOutboxBlobBackendForTesting({
      put: async () => {},
      get: async () => new Blob(["x"]),
      deletePrefix: async () => {},
      keys: async () => [],
    });
    enqueueOutboxEntry(
      entry("p1", {
        attachments: [
          { id: "att-1", kind: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 1 },
        ],
      }),
    );
    mocks.uploaded.mockReturnValueOnce(null).mockReturnValue([{ type: "file", id: "s1" }]);
    await mount();
    await settle();
    expect(mocks.startTurn).not.toHaveBeenCalled();
    expect(getOutboxSnapshot().entries[0]?.attempts).toBe(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(2_000)));
    expect(mocks.startTurn).toHaveBeenCalledOnce();
    expect(mocks.startTurn.mock.calls[0]?.[0].input.commandId).toBe("outbox:p1");
    expect(ids()).toEqual([]);
  });
});
