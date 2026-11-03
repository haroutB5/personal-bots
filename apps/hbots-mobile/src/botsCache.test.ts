import { PersonalBot, PersonalBotThread } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildBotsCache, readBotsCache, writeBotsCache, type BotsCacheStorage } from "./botsCache";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);
const decodeThread = Schema.decodeUnknownSync(PersonalBotThread);

function bot(input: { botId: string; name: string; title?: string; lead?: boolean }) {
  return decodeBot({
    botId: input.botId,
    name: input.name,
    title: input.title ?? "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#e3c477",
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    enabled: true,
    sortOrder: 0,
    lead: input.lead ?? false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function thread(input: { botId: string; threadId: string; archivedAt?: string | null }) {
  return decodeThread({
    botId: input.botId,
    threadId: input.threadId,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
  });
}

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const storage: BotsCacheStorage = {
    read: async () => value,
    write: async (next) => {
      value = next;
    },
    remove: async () => {
      value = null;
    },
  };
  return { storage, read: () => value };
}

const CACHE_INPUT = {
  environmentId: "env-1",
  serverVersion: "1.66.110",
  savedAtMs: new Date(2026, 10, 2, 14, 2).getTime(),
  bots: [
    bot({ botId: "b1", name: "Juno", title: "Lead", lead: true }),
    bot({ botId: "b2", name: "Scout" }),
  ],
  threads: [
    thread({ botId: "b1", threadId: "t1" }),
    thread({ botId: "b1", threadId: "t2", archivedAt: "2026-01-02T00:00:00.000Z" }),
    thread({ botId: "b2", threadId: "t3" }),
  ],
};

describe("bots cache", () => {
  it("round-trips the saved list", async () => {
    const memory = memoryStorage();
    const cache = buildBotsCache(CACHE_INPUT);

    await writeBotsCache(memory.storage, cache);
    const read = await readBotsCache(memory.storage, "env-1");

    expect(read).toEqual(cache);
    expect(read?.rows).toEqual([
      {
        botId: "b1",
        name: "Juno",
        lead: true,
        title: "Lead",
        model: "claude/claude-opus-5-5",
        chats: 1,
      },
      {
        botId: "b2",
        name: "Scout",
        lead: false,
        title: "",
        model: "claude/claude-opus-5-5",
        chats: 1,
      },
    ]);
  });

  it("reads a v2 entry as empty and drops it", async () => {
    const memory = memoryStorage(
      JSON.stringify({ version: 2, environmentId: "env-1", savedAtMs: 1, rows: [] }),
    );

    await expect(readBotsCache(memory.storage, "env-1")).resolves.toBeNull();
    expect(memory.read()).toBeNull();
  });

  it("reads a garbled entry as empty and drops it", async () => {
    const memory = memoryStorage("{not json");

    await expect(readBotsCache(memory.storage, "env-1")).resolves.toBeNull();
    expect(memory.read()).toBeNull();
  });

  it("drops a list saved for another environment", async () => {
    const memory = memoryStorage();
    await writeBotsCache(memory.storage, buildBotsCache(CACHE_INPUT));

    await expect(readBotsCache(memory.storage, "env-2")).resolves.toBeNull();
    expect(memory.read()).toBeNull();
  });

  it("stores no field a token or message body could enter", async () => {
    const memory = memoryStorage();
    const cache = buildBotsCache(CACHE_INPUT);
    await writeBotsCache(memory.storage, cache);

    expect(Object.keys(cache).sort()).toEqual([
      "environmentId",
      "rows",
      "savedAtMs",
      "serverVersion",
      "version",
    ]);
    expect(Object.keys(cache.rows[0] ?? {}).sort()).toEqual([
      "botId",
      "chats",
      "lead",
      "model",
      "name",
      "title",
    ]);
    const stored = memory.read() ?? "";
    expect(stored).not.toContain("token");
  });
});
