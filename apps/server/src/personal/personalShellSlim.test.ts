import { expect, it } from "@effect/vitest";
import type { OrchestrationShellSnapshot, OrchestrationThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemoryWorker } from "../persistence/Layers/Sqlite.ts";
import {
  archivedShellThreadNeeded,
  listArchivedBotThreadIds,
  listBotThreadIds,
  maybeSlimShellSnapshot,
  pickThreadShells,
  slimShellSnapshot,
} from "./personalShellSlim.ts";

const at = "2026-10-26T03:00:00.000Z";

const shell = (
  id: string,
  overrides: Partial<Record<keyof OrchestrationThreadShell, unknown>> = {},
): OrchestrationThreadShell =>
  ({
    id,
    latestTurn: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

const snapshot = (threads: ReadonlyArray<OrchestrationThreadShell>): OrchestrationShellSnapshot =>
  ({ snapshotSequence: 7, projects: [], threads, updatedAt: at }) as OrchestrationShellSnapshot;

it("keeps an archived chat that is working or waiting on the owner", () => {
  expect(archivedShellThreadNeeded(shell("idle"))).toBe(false);
  expect(archivedShellThreadNeeded(shell("t", { latestTurn: { state: "running" } }))).toBe(true);
  expect(archivedShellThreadNeeded(shell("t", { latestTurn: { state: "completed" } }))).toBe(false);
  expect(archivedShellThreadNeeded(shell("t", { session: { status: "running" } }))).toBe(true);
  expect(archivedShellThreadNeeded(shell("t", { session: { status: "starting" } }))).toBe(true);
  expect(archivedShellThreadNeeded(shell("t", { session: { status: "stopped" } }))).toBe(false);
  expect(archivedShellThreadNeeded(shell("t", { hasPendingApprovals: true }))).toBe(true);
  expect(archivedShellThreadNeeded(shell("t", { hasPendingUserInput: true }))).toBe(true);
});

it("drops idle archived chats and keeps everything else in order", () => {
  const full = snapshot([
    shell("open"),
    shell("archived-idle"),
    shell("archived-busy", { session: { status: "running" } }),
    shell("unlinked"),
  ]);
  const slim = slimShellSnapshot(full, new Set(["archived-idle", "archived-busy"]));
  expect(slim.threads.map((thread) => thread.id)).toEqual(["open", "archived-busy", "unlinked"]);
  expect(slim.snapshotSequence).toBe(7);
  // Nothing to drop: the same object goes out.
  expect(slimShellSnapshot(full, new Set())).toBe(full);
  expect(slimShellSnapshot(full, new Set(["other"]))).toBe(full);
});

it("picks the asked-for shells in the shell's order", () => {
  const full = snapshot([shell("a"), shell("b"), shell("c")]);
  expect(pickThreadShells(full, new Set(["c", "a"])).map((thread) => thread.id)).toEqual([
    "a",
    "c",
  ]);
  expect(pickThreadShells(full, new Set())).toEqual([]);
});

const seedLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const botId of ["bot-1", "bot-2"]) {
    yield* sql`
      INSERT INTO personal_bots (
        bot_id, name, description, instructions, avatar_shape, avatar_color,
        model_selection_json, enabled, sort_order, created_at, updated_at
      ) VALUES (
        ${botId}, ${botId}, '', '', 'blob', '#1A73E8',
        '{"instanceId":"codex","model":"gpt-6-astra"}', 1, 0, ${at}, ${at}
      )
    `;
  }
  yield* sql`
    INSERT INTO personal_bot_threads (thread_id, bot_id, created_at, archived_at) VALUES
      ('open-1', 'bot-1', ${at}, NULL),
      ('old-1', 'bot-1', ${at}, ${at}),
      ('old-2', 'bot-2', ${at}, ${at})
  `;
});

it.effect("reads the archived bot chats and one bot's chats", () =>
  Effect.gen(function* () {
    yield* seedLinks;
    const archived = yield* listArchivedBotThreadIds;
    expect([...archived].toSorted()).toEqual(["old-1", "old-2"]);
    const botOne = yield* listBotThreadIds({ botId: "bot-1" });
    expect([...botOne].toSorted()).toEqual(["old-1", "open-1"]);
    const named = yield* listBotThreadIds({ threadIds: ["old-2"] });
    expect([...named]).toEqual(["old-2"]);
  }).pipe(Effect.provide(SqlitePersistenceMemoryWorker)),
);

it.effect("slims only when asked and while the switch is on", () =>
  Effect.gen(function* () {
    yield* seedLinks;
    const full = snapshot([shell("open-1"), shell("old-1"), shell("old-2")]);
    const asked = yield* maybeSlimShellSnapshot(full, true);
    expect(asked.threads.map((thread) => thread.id)).toEqual(["open-1"]);
    const notAsked = yield* maybeSlimShellSnapshot(full, false);
    expect(notAsked).toBe(full);
    const previous = process.env.PB_PERF_OFF;
    process.env.PB_PERF_OFF = "shell-omit-archived";
    try {
      const switchedOff = yield* maybeSlimShellSnapshot(full, true);
      expect(switchedOff).toBe(full);
    } finally {
      if (previous === undefined) delete process.env.PB_PERF_OFF;
      else process.env.PB_PERF_OFF = previous;
    }
  }).pipe(Effect.provide(SqlitePersistenceMemoryWorker)),
);
