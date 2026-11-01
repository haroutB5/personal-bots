import { describe, expect, it } from "@effect/vitest";

import { createMemoryKeyValueStore } from "../testing/fakes.ts";
import {
  buildChatsSnapshot,
  dropChatFromSnapshot,
  readChatsSnapshot,
  readChatsSnapshotBeforeEnvironment,
  writeChatsSnapshot,
  type ChatsSnapshotRowInput,
} from "./chatsSnapshot.ts";

const STORAGE_KEY = "t3code:chats-snapshot:v3";
const LEGACY_KEY = "t3code:chats-snapshot:v2";

function input(
  botId: string,
  overrides: Partial<ChatsSnapshotRowInput> = {},
): ChatsSnapshotRowInput {
  return {
    botId,
    name: `Bot ${botId}`,
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    subtitle: "General assistant",
    previewLabel: "Delegated to Developer",
    previewAtMs: 1_757_800_000_000,
    threadId: `thread-${botId}`,
    threadTitle: `Thread ${botId}`,
    pinned: false,
    ...overrides,
  };
}

function build(environmentId: string, botIds: ReadonlyArray<string>) {
  return buildChatsSnapshot({
    environmentId,
    savedAtMs: 1_757_800_001_000,
    rows: botIds.map((botId) => input(botId, { pinned: botId === "b1" })),
  });
}

describe("chats snapshot on the key value port", () => {
  it("reads back the rows it wrote, synchronously", () => {
    const kv = createMemoryKeyValueStore();
    const snapshot = build("env-1", ["b1", "b2", "b3"]);
    writeChatsSnapshot(kv, "env-1", snapshot);
    const read = readChatsSnapshot(kv, "env-1");
    expect(read).toEqual(snapshot);
    expect(read?.rows.map((row) => row.botId)).toEqual(["b1", "b2", "b3"]);
    expect(read?.rows[0]).toEqual({
      botId: "b1",
      name: "Bot b1",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      subtitle: "General assistant",
      preview: "Delegated to Developer",
      previewAtMs: 1_757_800_000_000,
      threadId: "thread-b1",
      threadTitle: "Thread b1",
      pinned: true,
    });
    expect(JSON.parse(kv.getItem(STORAGE_KEY) ?? "null").environmentId).toBe("env-1");
  });

  it("reads the stored snapshot before the environment is known, and leaves it stored", () => {
    const kv = createMemoryKeyValueStore();
    const snapshot = build("env-1", ["b1", "b2"]);
    writeChatsSnapshot(kv, "env-1", snapshot);
    expect(readChatsSnapshotBeforeEnvironment(kv)).toEqual(snapshot);
    expect(kv.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("reads as empty and drops the old entry when only a v2 snapshot is stored", () => {
    const kv = createMemoryKeyValueStore({
      [LEGACY_KEY]: JSON.stringify({ environmentId: "env-1", snapshot: { version: 2, rows: [] } }),
    });
    expect(readChatsSnapshot(kv, "env-1")).toBeNull();
    expect(readChatsSnapshotBeforeEnvironment(kv)).toBeNull();
    expect(kv.getItem(LEGACY_KEY)).toBeNull();
  });

  it("reads as empty and clears the entry when the stored text is garbled", () => {
    const kv = createMemoryKeyValueStore({ [STORAGE_KEY]: "{not json" });
    expect(readChatsSnapshotBeforeEnvironment(kv)).toBeNull();
    expect(kv.getItem(STORAGE_KEY)).toBe("{not json");
    expect(readChatsSnapshot(kv, "env-1")).toBeNull();
    expect(kv.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reads as empty and clears the entry when the stored shape is a v2 row set under the v3 key", () => {
    const kv = createMemoryKeyValueStore({
      [STORAGE_KEY]: JSON.stringify({
        environmentId: "env-1",
        snapshot: { version: 2, environmentId: "env-1", savedAtMs: 1, rows: [] },
      }),
    });
    expect(readChatsSnapshot(kv, "env-1")).toBeNull();
    expect(kv.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reads as empty and clears the entry when it belongs to another environment", () => {
    const kv = createMemoryKeyValueStore();
    writeChatsSnapshot(kv, "env-1", build("env-1", ["b1"]));
    expect(readChatsSnapshot(kv, "env-2")).toBeNull();
    expect(kv.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reads null without an environment id", () => {
    const kv = createMemoryKeyValueStore();
    writeChatsSnapshot(kv, "env-1", build("env-1", ["b1"]));
    expect(readChatsSnapshot(kv, null)).toBeNull();
  });

  it("drops matching rows, and the whole entry once none are left", () => {
    const kv = createMemoryKeyValueStore();
    writeChatsSnapshot(kv, "env-1", build("env-1", ["b1", "b2", "b3"]));
    const afterOne = dropChatFromSnapshot(kv, "env-1", (row) => row.botId === "b2");
    expect(afterOne?.rows.map((row) => row.botId)).toEqual(["b1", "b3"]);
    expect(readChatsSnapshot(kv, "env-1")?.rows.map((row) => row.botId)).toEqual(["b1", "b3"]);
    expect(dropChatFromSnapshot(kv, "env-1", () => true)).toBeNull();
    expect(kv.getItem(STORAGE_KEY)).toBeNull();
  });

  it("clears the entry instead of throwing when the store refuses a write", () => {
    const kv = createMemoryKeyValueStore({ [STORAGE_KEY]: "stale" });
    const refusing = {
      ...kv,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeChatsSnapshot(refusing, "env-1", build("env-1", ["b1"]))).not.toThrow();
    expect(kv.getItem(STORAGE_KEY)).toBeNull();
  });
});
