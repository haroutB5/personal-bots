import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { buildChatsSnapshot, readChatsSnapshot, writeChatsSnapshot } from "./chatsSnapshot";
import { deleteChatConfirmMessage, useDeleteChat } from "./useDeleteChat";

const command = vi.hoisted(() => ({ result: { _tag: "Success" } as { _tag: string } }));

vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: async () => true }));
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
        providerLabel: "Claude Code",
        previewLabel: null,
        previewAtMs: 0,
        threadId: `thread-${key}`,
        threadTitle: `Thread ${key}`,
      })),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  command.result = { _tag: "Success" };
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

    expect(await deleteChat("thread-a" as ThreadId)).toBe(true);

    // Deletion happens from screens the Chats list is not mounted behind, so
    // without this the deleted chat keeps painting on every offline launch.
    expect(readChatsSnapshot("env-1")?.rows.map((row) => row.threadId)).toEqual(["thread-b"]);
  });

  it("keeps the snapshot when the delete itself failed", async () => {
    stubWindow();
    seedSnapshot();
    command.result = { _tag: "Failure" };
    const deleteChat = useDeleteChat("env-1" as EnvironmentId);

    expect(await deleteChat("thread-a" as ThreadId)).toBe(false);
    expect(readChatsSnapshot("env-1")?.rows.map((row) => row.threadId)).toEqual([
      "thread-a",
      "thread-b",
    ]);
  });
});
