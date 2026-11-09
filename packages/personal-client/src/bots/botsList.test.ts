import type { EnvironmentThreadShell } from "./threadShell.ts";
import {
  isBotPinned,
  PersonalBot,
  type PersonalBotThread,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { createManualClock, createMemoryKeyValueStore } from "../testing/fakes.ts";
import { buildBotSummaries, partitionPinnedSummaries } from "./botSummaries.ts";
import {
  buildChatsSnapshot,
  readChatsSnapshot,
  writeChatsSnapshot,
  type ChatsSnapshotRowInput,
} from "./chatsSnapshot.ts";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);
const NOW_MS = Date.parse("2026-10-05T12:00:00.000Z");

function bot(botId: string, name: string, sortOrder: number, pinned = false) {
  return decodeBot({
    botId,
    name,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId: "codex", model: "some-model" },
    enabled: true,
    sortOrder,
    pinned,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  });
}

function link(botId: string, threadId: string): PersonalBotThread {
  return {
    botId,
    threadId,
    createdAt: "2026-09-01T10:00:00.000Z",
    archivedAt: null,
  } as unknown as PersonalBotThread;
}

function shell(
  id: string,
  at: string,
  latestTurn: EnvironmentThreadShell["latestTurn"] = null,
): EnvironmentThreadShell {
  return {
    id,
    title: `Thread ${id}`,
    updatedAt: at,
    createdAt: at,
    latestUserMessageAt: null,
    archivedAt: null,
    latestTurn,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  } as unknown as EnvironmentThreadShell;
}

const provider = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
} as unknown as ServerProvider;

function fixture() {
  return {
    bots: [
      bot("working", "Working", 0),
      bot("idle-new", "Idle New", 1, true),
      bot("idle-old", "Idle Old", 2),
    ],
    links: [
      link("working", "t-working"),
      link("idle-new", "t-idle-new"),
      link("idle-old", "t-idle-old"),
    ],
    shells: [
      shell("t-working", "2026-10-05T09:00:00.000Z", {
        state: "running",
        requestedAt: "2026-10-05T09:00:00.000Z",
        startedAt: "2026-10-05T09:00:00.000Z",
        completedAt: null,
      } as EnvironmentThreadShell["latestTurn"]),
      shell("t-idle-new", "2026-10-05T11:00:00.000Z"),
      shell("t-idle-old", "2026-10-05T08:00:00.000Z"),
    ],
    providers: [provider],
  };
}

describe("bots list built from in-memory fixtures", () => {
  it("orders and partitions the list, then paints it back from the cache", () => {
    const clock = createManualClock(NOW_MS);
    const kv = createMemoryKeyValueStore();
    const summaries = buildBotSummaries({ ...fixture(), nowMs: clock.now() });

    expect(summaries.map((summary) => summary.bot.botId)).toEqual([
      "working",
      "idle-new",
      "idle-old",
    ]);
    expect(summaries[0]?.live).toBe(true);
    expect(summaries[0]?.newestThread?.id).toBe("t-working");
    expect(summaries[1]?.lastActivityMs).toBe(Date.parse("2026-10-05T11:00:00.000Z"));
    expect(partitionPinnedSummaries(summaries).pinned.map((summary) => summary.bot.botId)).toEqual([
      "idle-new",
    ]);

    const rows: ChatsSnapshotRowInput[] = summaries.map((summary) => ({
      botId: summary.bot.botId,
      name: summary.bot.name,
      avatarShape: summary.bot.avatarShape,
      avatarColor: summary.bot.avatarColor,
      subtitle: summary.modelLabel ?? "",
      previewLabel: summary.newestThread?.title ?? null,
      previewAtMs: summary.lastActivityMs,
      threadId: summary.newestThread?.id ?? null,
      threadTitle: summary.newestThread?.title ?? null,
      pinned: isBotPinned(summary.bot),
    }));
    const snapshot = buildChatsSnapshot({
      environmentId: "env-1",
      savedAtMs: clock.now(),
      rows,
    });
    writeChatsSnapshot(kv, "env-1", snapshot);

    const painted = readChatsSnapshot(kv, "env-1");
    expect(painted?.rows.map((row) => row.botId)).toEqual(["working", "idle-new", "idle-old"]);
    expect(painted?.rows[1]?.pinned).toBe(true);
  });

  it("builds the same rows with the activity memo switched off", () => {
    const on = buildBotSummaries({ ...fixture(), nowMs: NOW_MS });
    const off = buildBotSummaries({
      ...fixture(),
      nowMs: NOW_MS,
      readPerfOptimization: () => false,
    });

    expect(off.map((summary) => summary.bot.botId)).toEqual(on.map((summary) => summary.bot.botId));
    expect(off.map((summary) => summary.lastActivityMs)).toEqual(
      on.map((summary) => summary.lastActivityMs),
    );
  });
});
