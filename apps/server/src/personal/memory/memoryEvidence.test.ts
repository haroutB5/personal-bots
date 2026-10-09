import { PersonalBotId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PersonalMemoryService, layer as memoryLayer } from "./PersonalMemoryService.ts";
import {
  PersonalMemoryTidy,
  PersonalMemoryTidyJudge,
  layer as tidyLayer,
} from "./PersonalMemoryTidyService.ts";
import { ageWeight, RETRIEVAL_ENV } from "./memoryRetrieval.ts";
import { memoryProvenanceLabel } from "./memoryEvidence.ts";

const botId = PersonalBotId.make("evidence-bot");
const threadId = ThreadId.make("evidence-thread");
const base = { scope: "shared", scopeId: null, kind: "note", source: "user" } as const;
const TestLayer = memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const link = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO personal_bots (bot_id, name, description, instructions, avatar_shape, avatar_color,
    model_selection_json, enabled, sort_order, created_at, updated_at)
    VALUES (${botId}, 'Evidence bot', '', '', 'blob', '#112233', '{}', 1, 0, '1970-01-01', '1970-01-01')`;
  yield* sql`INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
    VALUES (${threadId}, ${botId}, '1970-01-01T00:00:00.000Z')`;
});

describe("memory evidence behaviour", () => {
  for (const mode of ["contextual", "legacy"]) {
    it.effect(
      `outdated only match is withheld in ${mode}, searchable with warning, and reversible`,
      () =>
        Effect.gen(function* () {
          yield* link;
          const memory = yield* PersonalMemoryService;
          const note = yield* memory.save({
            ...base,
            content: "Garden shed key under the blue pot.",
          });
          yield* memory.setFeedback({ memoryId: note.memoryId, signal: "outdated" });
          const previous = process.env[RETRIEVAL_ENV];
          const turn = yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              process.env[RETRIEVAL_ENV] = mode;
            }),
            () => memory.contextForThread({ threadId, query: "garden shed key", record: false }),
            () =>
              Effect.sync(() => {
                if (previous === undefined) delete process.env[RETRIEVAL_ENV];
                else process.env[RETRIEVAL_ENV] = previous;
              }),
          );
          expect(turn.memoryIds).not.toContain(note.memoryId);
          expect(turn.block ?? "").not.toContain("under the blue pot");
          const found = yield* memory.search({ query: "garden shed key", botId });
          expect(found[0]?.demoted).toBe("outdated");
          expect(memoryProvenanceLabel(found[0]!)).toContain("OUTDATED");
          yield* memory.setFeedback({ memoryId: note.memoryId, signal: "clear" });
          const restored = yield* memory.contextForThread({
            threadId,
            query: "garden shed key",
            record: false,
          });
          expect(restored.memoryIds).toContain(note.memoryId);
        }).pipe(Effect.provide(TestLayer)),
    );
  }

  it("explicit changing facts age across topics; stable facts retain their weight", () => {
    for (const content of [
      "Next appointment is Tuesday.",
      "Price is 20 pounds.",
      "Account balance is 50.",
    ]) {
      const fact = {
        memoryId: "x",
        kind: "note" as const,
        content,
        source: "user",
        updatedAtMs: 0,
        observedAt: "1969-12-04T00:00:00.000Z",
      };
      expect(ageWeight({ ...fact, temporalKind: "changing" }, 0)).toBe(0.25);
      expect(ageWeight({ ...fact, temporalKind: "stable" }, 0)).toBe(1);
    }
  });

  it.effect(
    "evidence survives retrieval, trace recording, replacement and Undo; legacy rows stay unknown",
    () =>
      Effect.gen(function* () {
        yield* link;
        const memory = yield* PersonalMemoryService;
        const input = {
          ...base,
          content: "Garden shed appointment is Tuesday.",
          temporalKind: "changing" as const,
          observedAt: "1969-12-30T00:00:00.000Z",
          verifiedAt: "1969-12-31T00:00:00.000Z",
          evidence: ["https://example.com/appointments"],
          originThreadId: threadId,
          originMessageId: "owner-message",
        };
        const saved = yield* memory.save(input);
        const turn = yield* memory.contextForThread({
          threadId,
          query: "garden shed appointment",
          messageId: "turn-a",
          record: true,
        });
        expect(turn.block).toContain("recheck the source");
        expect(turn.block).toContain(input.evidence[0]);
        const view = yield* memory.turnContext({ threadId, messageId: "turn-a" });
        expect(view?.notes[0]?.provenance).toContain("owner-message");
        const replacement = yield* memory.save({
          ...input,
          content: "Garden shed appointment is Wednesday.",
          replaces: [saved.memoryId],
          actorBotId: botId,
        });
        expect((yield* memory.get(saved.memoryId)).supersededBy).toBe(replacement.memoryId);
        yield* memory.undoNote({ memoryId: replacement.memoryId });
        const restored = yield* memory.get(saved.memoryId);
        expect(restored.supersededAt).toBeNull();
        expect(restored.evidence).toEqual(input.evidence);
        expect(restored.observedAt).toBe(input.observedAt);
        const legacy = yield* memory.save({ ...base, content: "The garden shed is wooden." });
        expect(legacy.temporalKind).toBeNull();
        expect(legacy.observedAt).toBeNull();
        expect(memoryProvenanceLabel(legacy)).toContain("observation date unknown");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "rejects unsupported verification, incomplete changing facts and credential-bearing references",
    () =>
      Effect.gen(function* () {
        const memory = yield* PersonalMemoryService;
        for (const extra of [
          { temporalKind: "changing" as const },
          { verifiedAt: "1969-12-31T00:00:00.000Z" },
          { evidence: ["https://example.com/item?token=synthetic-test-value"] },
          { evidence: ["https://example.com/item"], observedAt: "not-a-date" },
        ]) {
          const error = yield* Effect.flip(
            memory.save({ ...base, content: "A synthetic fact.", ...extra }),
          );
          expect(error.message.length).toBeGreaterThan(0);
        }
        expect(yield* memory.list({})).toEqual([]);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "nightly factual conflict keeps both claims and evidence instead of choosing the newer save",
    () => {
      const judge = Layer.succeed(PersonalMemoryTidyJudge, {
        model: "fake-evidence-judge",
        judge: () =>
          Effect.succeed({
            decisions: [
              {
                action: "supersede" as const,
                memoryIds: ["E2"],
                by: "E1",
                reason: "Newer appointment claim.",
              },
            ],
          }),
      });
      const layer = Layer.mergeAll(memoryLayer, tidyLayer.pipe(Layer.provide(judge))).pipe(
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      );
      return Effect.gen(function* () {
        yield* link;
        const memory = yield* PersonalMemoryService;
        const sql = yield* SqlClient.SqlClient;
        const older = yield* memory.save({
          ...base,
          content: "Appointment is Tuesday.",
          evidence: ["https://example.com/old"],
        });
        yield* sql`UPDATE personal_memory SET created_at = '1969-12-01', updated_at = '1969-12-01' WHERE memory_id = ${older.memoryId}`;
        const newer = yield* memory.save({
          ...base,
          content: "Appointment is Wednesday.",
          evidence: ["https://example.com/new"],
        });
        yield* sql`UPDATE personal_memory SET created_at = '1969-12-02', updated_at = '1969-12-02' WHERE memory_id = ${newer.memoryId}`;
        const tidy = yield* PersonalMemoryTidy;
        const preview = yield* tidy.run({ dryRun: true });
        expect(preview.superseded).toBe(0);
        expect((yield* memory.get(older.memoryId)).conflict).toBeNull();
        const run = yield* tidy.run({ dryRun: false });
        expect(run.superseded).toBe(0);
        const entries = yield* memory.list({});
        expect(entries).toHaveLength(2);
        expect(entries.every((entry) => entry.conflict?.includes("source verification"))).toBe(
          true,
        );
        expect(entries.flatMap((entry) => entry.evidence ?? [])).toEqual(
          expect.arrayContaining(["https://example.com/old", "https://example.com/new"]),
        );
        const turn = yield* memory.contextForThread({
          threadId,
          query: "appointment",
          record: false,
        });
        expect(turn.block).toContain("UNRESOLVED CONFLICT");
        expect(turn.block).toContain("Tuesday");
        expect(turn.block).toContain("Wednesday");
      }).pipe(Effect.provide(layer));
    },
  );
});
