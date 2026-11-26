import {
  PersonalBotId,
  PersonalMemoryId,
  ThreadId,
  type PersonalMemoryEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { formatMemoryBlock, memoryRef } from "./memoryBlock.ts";
import { RETRIEVAL_ENV } from "./memoryRetrieval.ts";
import { localDay } from "./memoryTidy.ts";
import { PersonalMemoryService } from "./PersonalMemoryService.ts";
import { personalMemoryTestLayer as memoryLayer } from "../test/personalReadsTestLayer.ts";
import { seedV2Thread } from "../test/v2ProjectionSeed.ts";

const TestLayer = memoryLayer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const BOT_A = PersonalBotId.make("bot-a");
const BOT_B = PersonalBotId.make("bot-b");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

const seedBots = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const [botId, threadId, team] of [
    [BOT_A, THREAD_A, "dev"],
    [BOT_B, THREAD_B, "ops"],
  ] as const) {
    yield* sql`
      INSERT INTO personal_bots (
        bot_id, name, description, instructions, avatar_shape, avatar_color,
        model_selection_json, enabled, sort_order, team, created_at, updated_at
      )
      VALUES (${botId}, ${botId}, '', '', 'blob', '#1A73E8', '{}', 1, 0, ${team}, ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
      VALUES (${threadId}, ${botId}, ${now})
    `;
    yield* seedV2Thread({ threadId, createdAt: now });
  }
});

const withRetrievalEnv = <A, E, R>(
  value: string | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[RETRIEVAL_ENV];
      if (value === undefined) delete process.env[RETRIEVAL_ENV];
      else process.env[RETRIEVAL_ENV] = value;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[RETRIEVAL_ENV];
        else process.env[RETRIEVAL_ENV] = previous;
      }),
  );

describe("Phase 1: write-time relative-date grounding", () => {
  it.effect("auto-stamps observedAt on note saves with relative dates and preserves dedup", () =>
    Effect.gen(function* () {
      const memory = yield* PersonalMemoryService;
      const now = yield* DateTime.now;
      const expectedYesterday = localDay(DateTime.toEpochMillis(now) - 86_400_000);

      const first = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "Deployed Matchday hotfix yesterday",
        source: "bot:bot-a;from=chat",
      });
      expect(first.created).toBe(true);
      expect(first.observedAt).toBe(expectedYesterday);
      expect(first.content).toBe("Deployed Matchday hotfix yesterday");

      // Exact-text dedup still works on repeat save
      const second = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "Deployed Matchday hotfix yesterday",
        source: "bot:bot-a;from=chat",
      });
      expect(second.created).toBe(false);
      expect(second.memoryId).toBe(first.memoryId);

      // Explicit observedAt is never overwritten
      const explicit = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "Checked backups yesterday",
        source: "bot:bot-a;from=chat",
        observedAt: "1969-12-15T00:00:00.000Z",
      });
      expect(explicit.observedAt).toBe("1969-12-15T00:00:00.000Z");

      // Preference is never auto-grounded or mutated
      const pref = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "preference",
        content: "Always check yesterday's logs before restarting",
        source: "user",
      });
      expect(pref.observedAt).toBeNull();
      expect(pref.content).toBe("Always check yesterday's logs before restarting");

      // temporalKind === "changing" validation remains strict (requires explicit observedAt)
      const changingResult = yield* memory
        .save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: "Current server status checked yesterday",
          source: "bot:bot-a;from=chat",
          temporalKind: "changing",
          evidence: ["https://example.com/status"],
        })
        .pipe(Effect.flip);
      expect(changingResult.message).toContain("Changing facts need observedAt");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("Phase 1: temporal query routing & replacement chains", () => {
  it.effect(
    "walks replaced ancestors (max 2 hops, max 4 total), excludes forgotten/undone/deleted, respects scope, and renders historical label",
    () =>
      Effect.gen(function* () {
        yield* seedBots;
        const memory = yield* PersonalMemoryService;
        const sql = yield* SqlClient.SqlClient;

        // Build a 4-node replacement chain: v0 -> v1 -> v2 -> v3
        const v0 = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: "Harout primary workstation laptop is Surface Pro",
          source: "user",
          observedAt: "1969-01-01T00:00:00.000Z",
        });
        const v1 = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: "Harout primary workstation laptop is Dell XPS",
          source: "user",
          observedAt: "1969-03-01T00:00:00.000Z",
          replaces: [v0.memoryId],
        });
        const v2 = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: "Harout primary workstation laptop is MacBook Pro",
          source: "user",
          observedAt: "1969-06-01T00:00:00.000Z",
          replaces: [v1.memoryId],
        });
        const v3 = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: "Harout primary workstation laptop is ThinkPad X1",
          source: "user",
          observedAt: "1969-09-01T00:00:00.000Z",
          replaces: [v2.memoryId],
        });

        // Add a forgotten note, an undone note, and a deleted note pointing to v3
        const forgotten = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: "Harout laptop forgotten entry",
          source: "user",
        });
        yield* memory.forget({ memoryId: forgotten.memoryId, actorBotId: BOT_A });

        const privateOld = yield* memory.save({
          scope: "bot",
          scopeId: BOT_B,
          kind: "note",
          content: "Bot B private workstation laptop secret",
          source: "bot:bot-b;from=chat",
        });
        yield* sql`
          UPDATE personal_memory
          SET superseded_at = '1969-08-01T00:00:00.000Z',
              superseded_by = ${v3.memoryId},
              superseded_reason = 'Replaced by a newer save.'
          WHERE memory_id = ${privateOld.memoryId}
        `;

        // Normal query returns ONLY current v3
        const normalSearch = yield* memory.search({
          query: "workstation laptop",
          botId: BOT_A,
        });
        expect(normalSearch.map((e) => e.memoryId)).toEqual([v3.memoryId]);

        // Temporal query auto-includes up to 2 hops back (v1, v2) + current (v3), sorted chronologically
        // v0 (3 hops back), forgotten, and privateOld (BOT_B scope) are excluded
        const temporalSearch = yield* memory.search({
          query: "what workstation laptop did Harout used to own?",
          botId: BOT_A,
        });
        expect(temporalSearch.map((e) => e.memoryId)).toEqual([
          v1.memoryId,
          v2.memoryId,
          v3.memoryId,
        ]);

        // Explicit includeHistory: true works on non-temporal queries too
        const explicitHistory = yield* memory.search({
          query: "workstation laptop",
          botId: BOT_A,
          includeHistory: true,
        });
        expect(explicitHistory.map((e) => e.memoryId)).toEqual([
          v1.memoryId,
          v2.memoryId,
          v3.memoryId,
        ]);

        // contextForThread renders history ancestors with explicit historical label
        const ctx = yield* memory.contextForThread({
          threadId: THREAD_A,
          query: "what workstation laptop did Harout used to own?",
          record: false,
        });
        expect(ctx.block).not.toBeNull();
        expect(ctx.block).toContain("ThinkPad X1");
        expect(ctx.block).toContain("MacBook Pro");
        expect(ctx.block).toContain("Dell XPS");
        expect(ctx.block).not.toContain("Surface Pro");
        expect(ctx.block).not.toContain("Bot B private");
        expect(ctx.block).toContain(`by ${memoryRef(v3)}: historical, not current]`);
        expect(ctx.block).toContain(`by ${memoryRef(v2)}: historical, not current]`);

        // Regular formatMemoryBlock relevant filtering remains unchanged: superseded entries in `relevant` are dropped
        const supersededV2 = yield* memory.get(v2.memoryId);
        const filteredBlock = formatMemoryBlock({
          preferences: [],
          relevant: [supersededV2],
        });
        expect(filteredBlock).toBeNull();

        // Kill switch T3CODE_PERSONAL_MEMORY_RETRIEVAL=legacy bypasses temporal routing cleanly
        const legacySearch = yield* withRetrievalEnv(
          "legacy",
          memory.search({
            query: "what workstation laptop did Harout used to own?",
            botId: BOT_A,
          }),
        );
        expect(legacySearch.map((e) => e.memoryId)).toEqual([v3.memoryId]);

        const legacyCtx = yield* withRetrievalEnv(
          "legacy",
          memory.contextForThread({
            threadId: THREAD_A,
            query: "what workstation laptop did Harout used to own?",
            record: false,
          }),
        );
        expect(legacyCtx.block).toContain("ThinkPad X1");
        expect(legacyCtx.block).not.toContain("historical, not current");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("caps replacement ancestors at 4 total when many entries were replaced", () =>
    Effect.gen(function* () {
      yield* seedBots;
      const memory = yield* PersonalMemoryService;

      const oldIds: Array<PersonalMemoryId> = [];
      for (let i = 1; i <= 6; i += 1) {
        const saved = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: `Legacy router model variant ${i}`,
          source: "user",
          observedAt: `1969-0${i}-01T00:00:00.000Z`,
        });
        oldIds.push(saved.memoryId);
      }
      const current = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "Current router model UniFi Dream Machine",
        source: "user",
        observedAt: "1969-10-01T00:00:00.000Z",
        replaces: oldIds,
      });

      const results = yield* memory.search({
        query: "router model",
        botId: BOT_A,
        includeHistory: true,
      });
      const ancestors = results.filter((entry: PersonalMemoryEntry) => entry.supersededAt != null);
      expect(ancestors).toHaveLength(4);
      expect(results.some((entry) => entry.memoryId === current.memoryId)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});
