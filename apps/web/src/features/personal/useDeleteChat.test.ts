import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { buildChatsSnapshot, readChatsSnapshot, writeChatsSnapshot } from "./chatsSnapshot";
import { deleteChatConfirmMessage, useDeleteChat } from "./useDeleteChat";

const command = vi.hoisted(() => ({
  result: { _tag: "Success" } as { readonly _tag: string; readonly cause?: unknown },
  confirmed: true,
}));

vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: async () => command.confirmed }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => command.result,
}));
vi.mock("./usePersonalBots", () => ({ personalBotDeleteThread: {} }));

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function stubWindow(): void {
  const localStorage = createLocalStorageStub();
  vi.stubGlobal("window", { localStorage, confirm: () => true });
  vi.stubGlobal("localStorage", localStorage);
}

function seedSnapshot(): void {
  writeChatsSnapshot(
    "env-1",
    buildChatsSnapshot({
      environmentId: "env-1",
      savedAtMs: 0,
      rows: ["a", "b"].map((key) => ({
        botId: `bot-${key}`,
        name: `Bot ${key}`,
        avatarShape: "blob" as const,
        avatarColor: "#1A73E8" as const,
        subtitle: "General assistant",
        previewLabel: null,
        previewAtMs: 0,
        threadId: `thread-${key}`,
        threadTitle: `Thread ${key}`,
        pinned: false,
      })),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  command.result = { _tag: "Success" };
  command.confirmed = true;
});

describe("deleteChatConfirmMessage", () => {
  it("states the deletion is permanent and cannot be undone", () => {
    const message = deleteChatConfirmMessage();
    expect(message).toContain("permanently");
    expect(message).toContain("can't be undone");
  });
});

describe("useDeleteChat", () => {
  it("drops the deleted chat from the cold-start snapshot", async () => {
    stubWindow();
    seedSnapshot();
    // The hook holds no state of its own, so calling it is the whole
    // component: it returns the deleter.
    const deleteChat = useDeleteChat("env-1" as EnvironmentId);

    expect(await deleteChat("thread-a" as ThreadId)).toEqual({ status: "done" });

    // Deletion happens from screens the Chats list is not mounted behind, so
    // without this the deleted chat keeps painting on every offline launch.
    expect(readChatsSnapshot("env-1")?.rows.map((row) => row.threadId)).toEqual(["thread-b"]);
  });

  it("reports the server's message instead of failing silently", async () => {
    stubWindow();
    seedSnapshot();
    command.result = { _tag: "Failure", cause: Cause.fail(new Error("Laptop unreachable")) };
    const deleteChat = useDeleteChat("env-1" as EnvironmentId);

    // A bare `false` was indistinguishable from "you cancelled": the dialog
    // closed, the chat stayed, and the only trace was a console warning.
    expect(await deleteChat("thread-a" as ThreadId)).toEqual({
      status: "failed",
      message: "Laptop unreachable",
    });
    expect(readChatsSnapshot("env-1")?.rows.map((row) => row.threadId)).toEqual([
      "thread-a",
      "thread-b",
    ]);
  });

  it("falls back to its own copy when the failure carries no message", async () => {
    stubWindow();
    seedSnapshot();
    command.result = { _tag: "Failure", cause: Cause.fail("nope") };

    expect(await useDeleteChat("env-1" as EnvironmentId)("thread-a" as ThreadId)).toEqual({
      status: "failed",
      message: "Couldn't delete this chat. Try again.",
    });
  });

  it("stays quiet when the confirmation was declined", async () => {
    stubWindow();
    seedSnapshot();
    command.confirmed = false;

    expect(await useDeleteChat("env-1" as EnvironmentId)("thread-a" as ThreadId)).toEqual({
      status: "cancelled",
    });
    expect(readChatsSnapshot("env-1")?.rows.map((row) => row.threadId)).toEqual([
      "thread-a",
      "thread-b",
    ]);
  });
});
