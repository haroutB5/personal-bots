import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemoryWorker } from "../persistence/Layers/Sqlite.ts";
import {
  personalThreadLinkIntentKey,
  repairPersonalThreadLinks,
} from "./personalThreadLinkRepair.ts";

/**
 * The boot repair for a chat creation a process death interrupted between its
 * thread and its bot link. Runs on the same worker path as production.
 */

const testLayer = SqlitePersistenceMemoryWorker;

const at = "2026-10-18T03:00:00.000Z";

const seed = (input: {
  readonly threadId: string;
  readonly botId: string;
  readonly intent: boolean;
  readonly projection: "live" | "deleted" | "missing";
  readonly bot: "live" | "deleted" | "missing";
  readonly link: boolean;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (input.bot !== "missing") {
      yield* sql`
        INSERT INTO personal_bots (
          bot_id, name, description, instructions, avatar_shape, avatar_color,
          model_selection_json, enabled, sort_order, created_at, updated_at, deleted_at
        ) VALUES (
          ${input.botId}, 'Ada', '', '', 'blob', '#1A73E8',
          '{"instanceId":"codex","model":"gpt-6-astra"}', 1, 0, ${at}, ${at},
          ${input.bot === "deleted" ? at : null}
        )
      `;
    }
    if (input.projection !== "missing") {
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, deleted_at)
        VALUES (
          ${input.threadId}, 'project-1', 'QA chat', ${at}, ${at},
          ${input.projection === "deleted" ? at : null}
        )
      `;
    }
    if (input.link) {
      yield* sql`
        INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
        VALUES (${input.threadId}, ${input.botId}, ${at})
      `;
    }
    if (input.intent) {
      yield* sql`
        INSERT INTO personal_meta (key, value)
        VALUES (${personalThreadLinkIntentKey(input.threadId)}, ${input.botId})
      `;
    }
  });

const linkCount = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT count(*) AS "count" FROM personal_bot_threads WHERE thread_id = ${threadId}
    `;
    return rows[0]?.count ?? -1;
  });

const intentCount = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT count(*) AS "count" FROM personal_meta
      WHERE key = ${personalThreadLinkIntentKey(threadId)}
    `;
    return rows[0]?.count ?? -1;
  });

it.effect("links a live projection whose intent was left behind", () =>
  Effect.gen(function* () {
    yield* seed({
      threadId: "thread-orphan",
      botId: "bot-1",
      intent: true,
      projection: "live",
      bot: "live",
      link: false,
    });
    const summary = yield* repairPersonalThreadLinks();
    expect(summary).toEqual({ linked: 1, dropped: 1 });
    expect(yield* linkCount("thread-orphan")).toBe(1);
    expect(yield* intentCount("thread-orphan")).toBe(0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("drops an intent whose thread never landed", () =>
  Effect.gen(function* () {
    yield* seed({
      threadId: "thread-nothing",
      botId: "bot-1",
      intent: true,
      projection: "missing",
      bot: "live",
      link: false,
    });
    const summary = yield* repairPersonalThreadLinks();
    expect(summary).toEqual({ linked: 0, dropped: 1 });
    expect(yield* linkCount("thread-nothing")).toBe(0);
    expect(yield* intentCount("thread-nothing")).toBe(0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("drops an intent for a deleted thread or a deleted bot", () =>
  Effect.gen(function* () {
    yield* seed({
      threadId: "thread-deleted",
      botId: "bot-1",
      intent: true,
      projection: "deleted",
      bot: "live",
      link: false,
    });
    yield* seed({
      threadId: "thread-dead-bot",
      botId: "bot-gone",
      intent: true,
      projection: "live",
      bot: "deleted",
      link: false,
    });
    const summary = yield* repairPersonalThreadLinks();
    expect(summary).toEqual({ linked: 0, dropped: 2 });
    expect(yield* linkCount("thread-deleted")).toBe(0);
    expect(yield* linkCount("thread-dead-bot")).toBe(0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("leaves an existing link alone and clears its intent", () =>
  Effect.gen(function* () {
    yield* seed({
      threadId: "thread-linked",
      botId: "bot-1",
      intent: true,
      projection: "live",
      bot: "live",
      link: true,
    });
    const summary = yield* repairPersonalThreadLinks();
    expect(summary).toEqual({ linked: 0, dropped: 1 });
    expect(yield* linkCount("thread-linked")).toBe(1);
    expect(yield* intentCount("thread-linked")).toBe(0);
  }).pipe(Effect.provide(testLayer)),
);
