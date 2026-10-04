// Pending app-scope changes ("rescope") through the proposals importer (1.60.40).
import { PersonalBotId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
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

const BOT_A = PersonalBotId.make("bot-a");
const THREAD_M = ThreadId.make("thread-matchday");
const THREAD_H = ThreadId.make("thread-hbots");

const judge = Layer.succeed(PersonalMemoryTidyJudge, {
  model: "fake-model",
  judge: () => Effect.succeed({ decisions: [] }),
});

const TestLayer = Layer.mergeAll(tidyLayer.pipe(Layer.provide(judge)), memoryLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO personal_bots (
    bot_id, name, description, instructions, avatar_shape, avatar_color,
    model_selection_json, enabled, sort_order, created_at, updated_at
  ) VALUES (${BOT_A}, 'Bot', '', '', 'blob', '#1A73E8', '{}', 1, 0, '2026-10-01', '2026-10-01')`;
  for (const [thread, title] of [
    [THREAD_M, "matchday"],
    [THREAD_H, "hbots"],
  ] as const) {
    yield* sql`INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
      VALUES (${thread}, ${BOT_A}, '2026-10-01')`;
    yield* sql`INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at
      ) VALUES (${thread}, 'p', ${title}, '{"instanceId":"codex","model":"m"}',
        'full-access', 'default', '2026-10-01', '2026-10-01')`;
  }
  const memory = yield* PersonalMemoryService;
  const save = (content: string, kind: "note" | "preference" = "preference") =>
    memory.save({ scope: "shared", scopeId: null, kind, content, source: "user" });
  return {
    memory,
    dots: yield* save("Matchday dots show the name only."),
    plain: yield* save("Always answer in plain words."),
    fact: yield* save("A fact about tea.", "note"),
  };
});

const decideWithHash = (changeId: number, approve: boolean) =>
  Effect.gen(function* () {
    const tidy = yield* PersonalMemoryTidy;
    const log = yield* tidy.log({ limit: 60 });
    const change = log.runs.flatMap((run) => run.changes).find((c) => c.changeId === changeId)!;
    return yield* tidy.decide({ changeId, approve, changeHash: change.changeHash });
  });

const blockFor = (memory: PersonalMemoryService["Service"], threadId: ThreadId, query: string) =>
  memory
    .contextForThread({ threadId, query, record: false })
    .pipe(Effect.map((c) => c.block ?? ""));

it.effect("a rescope waits for the owner, then limits the rule to its app", () =>
  Effect.gen(function* () {
    const { memory, dots, plain } = yield* setup;
    const tidy = yield* PersonalMemoryTidy;
    const run = yield* tidy.importProposals({
      source: "scope.json",
      items: [
        {
          action: "rescope",
          memoryIds: [dots.memoryId],
          toApps: ["matchday"],
          reason: "A Matchday display rule.",
        },
      ],
    });
    const change = run.changes[0]!;
    expect(change.status).toBe("pending");
    expect(change.action).toBe("rescope");
    expect(change.toApps).toEqual(["matchday"]);
    expect(change.memoryIds).toEqual([dots.memoryId]);
    // The exact text is in memory, bound by hash; nothing changed yet.
    expect((yield* memory.get(dots.memoryId)).apps).toBeNull();
    expect(yield* blockFor(memory, THREAD_H, "hello")).toContain(
      "Matchday dots show the name only.",
    );

    yield* decideWithHash(change.changeId, true);
    const after = yield* memory.get(dots.memoryId);
    expect(after.apps).toEqual(["matchday"]);
    expect(after.content).toBe("Matchday dots show the name only.");
    expect(after.scope).toBe("shared");
    // Reach by app: the hbots chat now gets an index line, the Matchday chat the rule.
    const hbots = yield* blockFor(memory, THREAD_H, "hello");
    expect(hbots).not.toContain("Matchday dots show the name only.");
    expect(hbots).toContain("Matchday: 1 rule");
    expect(hbots).toContain("Always answer in plain words.");
    expect(yield* blockFor(memory, THREAD_M, "hello")).toContain(
      "Matchday dots show the name only.",
    );
    expect((yield* memory.get(plain.memoryId)).apps).toBeNull();
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("a rescope back to global is its own change", () =>
  Effect.gen(function* () {
    const { memory, dots } = yield* setup;
    const tidy = yield* PersonalMemoryTidy;
    const first = yield* tidy.importProposals({
      source: "a.json",
      items: [{ action: "rescope", memoryIds: [dots.memoryId], toApps: ["matchday"], reason: "x" }],
    });
    yield* decideWithHash(first.changes[0]!.changeId, true);
    const back = yield* tidy.importProposals({
      source: "b.json",
      items: [{ action: "rescope", memoryIds: [dots.memoryId], toApps: null, reason: "Global." }],
    });
    expect(back.changes[0]!.status).toBe("pending");
    expect(back.changes[0]!.toApps).toBeNull();
    yield* decideWithHash(back.changes[0]!.changeId, true);
    expect((yield* memory.get(dots.memoryId)).apps).toBeNull();
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses a tap on an out-of-date card, and an edit in between makes it stale", () =>
  Effect.gen(function* () {
    const { memory, dots } = yield* setup;
    const tidy = yield* PersonalMemoryTidy;
    const run = yield* tidy.importProposals({
      source: "scope.json",
      items: [{ action: "rescope", memoryIds: [dots.memoryId], toApps: ["matchday"], reason: "x" }],
    });
    const change = run.changes[0]!;
    const wrong = yield* Effect.flip(
      tidy.decide({ changeId: change.changeId, approve: true, changeHash: "not-the-hash" }),
    );
    expect(wrong.message).toContain("out of date");
    // The owner edits the rule before tapping: the approval no longer fits.
    yield* memory.update({
      memoryId: dots.memoryId,
      content: "Matchday dots show the name and number.",
    });
    const stale = yield* Effect.flip(decideWithHash(change.changeId, true));
    expect(stale.message).toContain("changed");
    expect((yield* memory.get(dots.memoryId)).apps).toBeNull();
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("leaves notes, unchanged scopes and unknown entries alone, and never asks twice", () =>
  Effect.gen(function* () {
    const { dots, fact } = yield* setup;
    const tidy = yield* PersonalMemoryTidy;
    const items = [
      {
        action: "rescope" as const,
        memoryIds: [fact.memoryId],
        toApps: ["matchday"],
        reason: "A note.",
      },
      {
        action: "rescope" as const,
        memoryIds: [dots.memoryId],
        toApps: null,
        reason: "Already global.",
      },
      { action: "rescope" as const, memoryIds: ["nope"], toApps: ["matchday"], reason: "Gone." },
      {
        action: "rescope" as const,
        memoryIds: [dots.memoryId],
        toApps: ["matchday"],
        reason: "Ok.",
      },
    ];
    const run = yield* tidy.importProposals({ source: "mixed.json", items });
    expect(run.changes.map((change) => change.status)).toEqual(["left", "left", "left", "pending"]);
    const again = yield* tidy.importProposals({ source: "mixed2.json", items });
    expect(again.changes.filter((change) => change.status === "pending")).toHaveLength(0);
    // A turned-down scope is not asked again either.
    yield* decideWithHash(run.changes[3]!.changeId, false);
    const third = yield* tidy.importProposals({ source: "mixed3.json", items });
    expect(third.changes.filter((change) => change.status === "pending")).toHaveLength(0);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("a bot's new rule carries its apps onto the card and into the saved entry", () =>
  Effect.gen(function* () {
    const { memory } = yield* setup;
    const tidy = yield* PersonalMemoryTidy;
    const changeId = yield* memory.propose({
      action: "save",
      botId: BOT_A,
      threadId: THREAD_M,
      kind: "preference",
      scope: "shared",
      scopeId: null,
      content: "Matchday: never show the FC 26 card on a dot tap.",
      apps: ["Matchday"],
      replaces: [],
      reason: "Asked in chat",
    });
    const cards = yield* tidy.cardsForThread(THREAD_M);
    expect(cards.cards[0]?.apps).toEqual(["matchday"]);
    yield* tidy.decide({
      changeId,
      approve: true,
      changeHash: cards.cards[0]!.changeHash,
    });
    const saved = (yield* memory.list({ kind: "preference" })).find((entry) =>
      entry.content.startsWith("Matchday: never show"),
    )!;
    expect(saved.apps).toEqual(["matchday"]);
  }).pipe(Effect.provide(TestLayer)),
);
