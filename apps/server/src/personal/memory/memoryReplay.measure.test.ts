// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
// A replay of real recent user messages against a read-only copy of the live memory,
// before (1.60.38: keyword retrieval, every rule global) and after (1.60.40).
//
// Off by default. To run it:
//   HBOTS_MEMORY_REPLAY_DB=<path to state.sqlite> HBOTS_MEMORY_REPLAY_OUT=<folder> \
//     vp test run src/personal/memory/memoryReplay.measure.test.ts
// The live database is opened read-only and never written; the replay runs on an in-memory copy
// of its memory rows, bots, chat titles and the messages around each sampled message.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { PersonalBotId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { APP_SCOPING_ENV, detectActiveApps, MEMORY_APPS, mentionsApp } from "./memoryApps.ts";
import { isStatusLike, RETRIEVAL_ENV } from "./memoryRetrieval.ts";
import { PersonalMemoryService, layer as memoryLayer } from "./PersonalMemoryService.ts";

const LIVE_DB = process.env.HBOTS_MEMORY_REPLAY_DB;
const OUT_DIR = process.env.HBOTS_MEMORY_REPLAY_OUT;
const SCOPES_FILE = process.env.HBOTS_MEMORY_REPLAY_SCOPES;
const DAY = 86_400_000;

const TestLayer = memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

interface Sample {
  readonly messageId: string;
  readonly threadId: string;
  readonly botId: string;
  readonly text: string;
  readonly title: string;
  readonly before: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
  }>;
  readonly at: string;
}

const readLive = (live: string) => {
  const db = new NodeSqlite.DatabaseSync(live, { readOnly: true });
  db.exec("PRAGMA query_only=1");
  const since = new Date(Date.now() - 10 * DAY).toISOString();
  const all = db
    .prepare(
      `SELECT m.message_id AS id, m.thread_id AS tid, m.text AS text, m.created_at AS at,
         l.bot_id AS botId, COALESCE(t.title, '') AS title
       FROM projection_thread_messages m
       JOIN personal_bot_threads l ON l.thread_id = m.thread_id
       LEFT JOIN projection_threads t ON t.thread_id = m.thread_id
       WHERE m.role = 'user' AND m.message_id NOT LIKE 'personal-%' AND m.created_at > ?
       ORDER BY m.created_at DESC LIMIT 3000`,
    )
    .all(since) as Array<{
    id: string;
    tid: string;
    text: string;
    at: string;
    botId: string;
    title: string;
  }>;
  const short = all.filter((row) => row.text.length <= 40);
  const long = all.filter((row) => row.text.length > 40);
  // Every short follow-up, plus an even spread of longer messages.
  const picked = [
    ...short,
    ...long.filter((_, index) => index % Math.ceil(long.length / 80) === 0),
  ];
  const previous = db.prepare(
    `SELECT message_id AS id, role, substr(text, 1, 1500) AS text FROM projection_thread_messages
     WHERE thread_id = ? AND created_at < ? AND role IN ('user','assistant')
     ORDER BY created_at DESC LIMIT 4`,
  );
  const samples: Array<Sample> = picked.map((row) => ({
    messageId: row.id,
    threadId: row.tid,
    botId: row.botId,
    text: row.text.slice(0, 8000),
    title: row.title,
    at: row.at,
    before: previous.all(row.tid, row.at) as Array<{ id: string; role: string; text: string }>,
  }));
  const memory = db
    .prepare(
      `SELECT memory_id, scope, scope_id, kind, content, source, sensitivity, created_at, updated_at, version
       FROM personal_memory WHERE deleted_at IS NULL AND superseded_at IS NULL`,
    )
    .all() as Array<Record<string, string | number | null>>;
  const bots = db
    .prepare(`SELECT bot_id, name, description, team FROM personal_bots`)
    .all() as Array<Record<string, string | null>>;
  db.close();
  return { samples, memory, bots };
};

const estimateKind = (entry: { kind: string; content: string; source: string }) =>
  isStatusLike({
    kind: entry.kind as "note" | "preference" | "task_summary",
    content: entry.content,
    source: entry.source,
  });

interface Shot {
  readonly rules: number;
  readonly indexLine: boolean;
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly ageDays: number;
    readonly status: boolean;
    readonly text: string;
  }>;
  readonly relevantChars: number;
  readonly ruleChars: number;
  /** Entries naming a registered app other than the chat's own (only counted when the chat has one). */
  readonly otherAppEntries: number;
  readonly chatHasApp: boolean;
  readonly ms: number;
}

describe.skipIf(LIVE_DB === undefined)("replay of real messages: before and after", () => {
  it.effect(
    "measures the injected rules and notes",
    () =>
      Effect.gen(function* () {
        const live = readLive(LIVE_DB!);
        const sql = yield* SqlClient.SqlClient;
        const memory = yield* PersonalMemoryService;
        const scopes = new Map<string, string>();
        if (SCOPES_FILE !== undefined) {
          const rows = JSON.parse(NodeFS.readFileSync(SCOPES_FILE, "utf8")) as Array<{
            id: string;
            app: string;
          }>;
          for (const row of rows) scopes.set(row.id, row.app);
        }
        for (const bot of live.bots) {
          yield* sql`INSERT INTO personal_bots (
            bot_id, name, description, instructions, avatar_shape, avatar_color,
            model_selection_json, enabled, sort_order, created_at, updated_at, team
          ) VALUES (${bot.bot_id}, ${bot.name}, ${bot.description ?? ""}, '', 'blob', '#1A73E8', '{}', 1, 0,
            '2026-10-01', '2026-10-01', ${bot.team})`;
        }
        for (const row of live.memory) {
          yield* sql`INSERT INTO personal_memory (
            memory_id, scope, scope_id, kind, content, source, sensitivity,
            created_at, updated_at, deleted_at, version, apps_json
          ) VALUES (${row.memory_id as string}, ${row.scope as string}, ${row.scope_id as string | null},
            ${row.kind as string}, ${row.content as string}, ${row.source as string}, 'normal',
            ${row.created_at as string}, ${row.updated_at as string}, NULL, ${row.version as number},
            ${scopes.has(row.memory_id as string) ? JSON.stringify([scopes.get(row.memory_id as string)]) : null})`;
        }
        const insertedThreads = new Set<string>();
        const results: Array<{
          sample: Pick<Sample, "messageId" | "text" | "title" | "botId">;
          legacy: Shot;
          current: Shot;
        }> = [];
        const nowMs = Date.now();
        for (const sample of live.samples) {
          if (!insertedThreads.has(sample.threadId)) {
            insertedThreads.add(sample.threadId);
            yield* sql`INSERT OR IGNORE INTO personal_bot_threads (thread_id, bot_id, created_at)
              VALUES (${sample.threadId}, ${sample.botId}, '2026-10-01')`;
            yield* sql`INSERT OR IGNORE INTO projection_threads (
              thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
              created_at, updated_at
            ) VALUES (${sample.threadId}, 'p', ${sample.title}, '{"instanceId":"codex","model":"m"}',
              'full-access', 'default', '2026-10-01', '2026-10-01')`;
          }
          // Only this message and the four before it exist, as when it was sent.
          yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${sample.threadId}`;
          let offset = sample.before.length + 1;
          for (const before of sample.before.toReversed()) {
            offset -= 1;
            yield* sql`INSERT INTO projection_thread_messages
              (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
              VALUES (${before.id}, ${sample.threadId}, NULL, ${before.role}, ${before.text}, 0,
              ${new Date(Date.parse(sample.at) - offset * 1000).toISOString()},
              ${new Date(Date.parse(sample.at) - offset * 1000).toISOString()})`;
          }
          yield* sql`INSERT INTO projection_thread_messages
            (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
            VALUES (${sample.messageId}, ${sample.threadId}, NULL, 'user', ${sample.text}, 0,
            ${sample.at}, ${sample.at})`;

          const run = (legacy: boolean) =>
            Effect.gen(function* () {
              const previousScoping = process.env[APP_SCOPING_ENV];
              const previousRetrieval = process.env[RETRIEVAL_ENV];
              if (legacy) {
                process.env[APP_SCOPING_ENV] = "off";
                process.env[RETRIEVAL_ENV] = "legacy";
              }
              const started = performance.now();
              try {
                const turn = yield* memory.contextForThread({
                  threadId: ThreadId.make(sample.threadId),
                  query: sample.text,
                  record: false,
                  messageId: sample.messageId,
                });
                const ms = performance.now() - started;
                const lines = (turn.block ?? "").split("\n").slice(1);
                const ids = new Map(
                  live.memory.map((row) => [String(row.memory_id).slice(0, 8), row]),
                );
                const entries = lines
                  .filter(
                    (line) => line.startsWith("- [note]") || line.startsWith("- [task summary]"),
                  )
                  .map((line) => {
                    const id = /· ([0-9a-f]{8})/.exec(line)?.[1] ?? "";
                    const row = ids.get(id);
                    const updated = row === undefined ? nowMs : Date.parse(String(row.updated_at));
                    return {
                      id,
                      kind: line.startsWith("- [note]") ? "note" : "task_summary",
                      ageDays: Math.round((nowMs - updated) / DAY),
                      status:
                        row === undefined
                          ? false
                          : estimateKind({
                              kind: String(row.kind),
                              content: String(row.content),
                              source: String(row.source),
                            }),
                      text: line.replace(/^- \[[a-z ]+\] \[[^\]]*\] /, "").slice(0, 110),
                    };
                  });
                const ruleLines = lines.filter((line) => line.startsWith("- [preference]"));
                const chatApps = detectActiveApps({
                  title: sample.title,
                  current: sample.text,
                  recent: sample.before
                    .filter((before) => before.role === "user")
                    .map((before) => before.text),
                }).map((app) => app.slug);
                const otherAppEntries =
                  chatApps.length === 0
                    ? 0
                    : entries.filter((entry) => {
                        const full = String(ids.get(entry.id)?.content ?? entry.text);
                        return (
                          !chatApps.some((slug) => mentionsApp(full, slug)) &&
                          MEMORY_APPS.some((app) => mentionsApp(full, app.slug))
                        );
                      }).length;
                return {
                  rules: ruleLines.length,
                  indexLine: lines.some((line) => line.includes("Rules for other apps")),
                  entries,
                  relevantChars: entries.reduce((total, entry) => total + entry.text.length, 0),
                  ruleChars: ruleLines.reduce((total, line) => total + line.length, 0),
                  otherAppEntries,
                  chatHasApp: chatApps.length > 0,
                  ms: Math.round(ms * 10) / 10,
                } satisfies Shot;
              } finally {
                if (previousScoping === undefined) delete process.env[APP_SCOPING_ENV];
                else process.env[APP_SCOPING_ENV] = previousScoping;
                if (previousRetrieval === undefined) delete process.env[RETRIEVAL_ENV];
                else process.env[RETRIEVAL_ENV] = previousRetrieval;
              }
            });
          const legacy = yield* run(true);
          const current = yield* run(false);
          results.push({
            sample: {
              messageId: sample.messageId,
              text: sample.text.slice(0, 120),
              title: sample.title,
              botId: sample.botId,
            },
            legacy,
            current,
          });
        }
        const stats = (pick: (row: (typeof results)[number]) => Shot) => {
          const shots = results.map(pick);
          const sum = (f: (shot: Shot) => number) =>
            shots.reduce((total, shot) => total + f(shot), 0);
          const ms = shots.map((shot) => shot.ms).toSorted((a, b) => a - b);
          const entries = shots.flatMap((shot) => shot.entries);
          return {
            turns: shots.length,
            avgRules: sum((s) => s.rules) / shots.length,
            avgRuleChars: sum((s) => s.ruleChars) / shots.length,
            avgEntries: sum((s) => s.entries.length) / shots.length,
            avgRelevantChars: sum((s) => s.relevantChars) / shots.length,
            turnsWithNoEntries: shots.filter((s) => s.entries.length === 0).length,
            statusShare:
              entries.length === 0 ? 0 : entries.filter((e) => e.status).length / entries.length,
            oldStatusShare:
              entries.length === 0
                ? 0
                : entries.filter((e) => e.status && e.ageDays > 14).length / entries.length,
            indexLines: shots.filter((s) => s.indexLine).length,
            turnsInAppChats: shots.filter((s) => s.chatHasApp).length,
            avgOtherAppEntriesInAppChats:
              sum((s) => s.otherAppEntries) / Math.max(1, shots.filter((s) => s.chatHasApp).length),
            shareOtherAppEntriesInAppChats:
              sum((s) => s.otherAppEntries) /
              Math.max(
                1,
                shots.filter((s) => s.chatHasApp).reduce((t, s) => t + s.entries.length, 0),
              ),
            msP50: ms[Math.floor(ms.length * 0.5)],
            msP95: ms[Math.floor(ms.length * 0.95)],
            msMax: ms.at(-1),
          };
        };
        const summary = { legacy: stats((r) => r.legacy), current: stats((r) => r.current) };
        if (OUT_DIR !== undefined) {
          NodeFS.writeFileSync(`${OUT_DIR}/replay-results.json`, JSON.stringify(results, null, 1));
          NodeFS.writeFileSync(`${OUT_DIR}/replay-summary.json`, JSON.stringify(summary, null, 2));
        }
        expect(results.length).toBeGreaterThan(0);
        // The whole retrieval stays far under a long event-loop block.
        expect(summary.current.msMax!).toBeLessThan(150);
      }).pipe(Effect.provide(TestLayer)),
    300_000,
  );
});

// Referenced so the PersonalBotId import documents the ids used above.
void PersonalBotId;
