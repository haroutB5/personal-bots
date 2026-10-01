import { PersonalBotId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { TidyJudgeOutput } from "./memoryTidy.ts";
import { PersonalMemoryService, layer as memoryLayer } from "./PersonalMemoryService.ts";
import {
  PersonalMemoryTidy,
  PersonalMemoryTidyJudge,
  layer as tidyLayer,
} from "./PersonalMemoryTidyService.ts";

const BOT_A = PersonalBotId.make("bot-a");

/**
 * A model stand-in: reads the prompt's JSON lines, finds refs by a word in
 * their text, and answers with the given rules. Every prompt it saw is kept.
 */
const prompts: Array<string> = [];
const fakeJudge = (answer: (ref: (needle: string) => string) => TidyJudgeOutput["decisions"]) =>
  Layer.succeed(PersonalMemoryTidyJudge, {
    model: "fake-model",
    judge: (prompt) =>
      Effect.sync(() => {
        prompts.push(prompt);
        const ref = (needle: string) => {
          const line = prompt
            .split("\n")
            .find((text) => text.startsWith("{") && text.includes(needle));
          return line === undefined ? "E999" : (JSON.parse(line) as { ref: string }).ref;
        };
        return { decisions: answer(ref) };
      }),
  });

const testLayer = (judge: Layer.Layer<PersonalMemoryTidyJudge>) =>
  Layer.mergeAll(tidyLayer.pipe(Layer.provide(judge)), memoryLayer).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const seed = Effect.gen(function* () {
  const memory = yield* PersonalMemoryService;
  const sql = yield* SqlClient.SqlClient;
  const save = (
    content: string,
    daysAgo: number,
    options: { kind?: "note" | "preference"; scope?: "shared" | "bot" | "team" } = {},
  ) =>
    Effect.gen(function* () {
      const scope = options.scope ?? "shared";
      const entry = yield* memory.save({
        scope,
        scopeId: scope === "bot" ? BOT_A : scope === "team" ? "dev" : null,
        kind: options.kind ?? "note",
        content,
        source: "bot:cto",
      });
      const at = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: daysAgo }));
      yield* sql`UPDATE personal_memory SET created_at = ${at}, updated_at = ${at}
        WHERE memory_id = ${entry.memoryId}`;
      return entry.memoryId;
    });
  return {
    oldModels: yield* save("Dev team models (27 Sep): everyone on Opus 5.5 medium.", 5),
    newModels: yield* save("Dev team models (1 Oct): Backend Opus 5.5, QA on GPT-6.1 Sol.", 1),
    capA: yield* save("At most 5 bots run at once, per bot.", 6, { kind: "preference" }),
    capB: yield* save("At most 5 bots run at once in total.", 5, { kind: "preference" }),
    building: yield* save("hbots Back rule, being built in 1.47.3.", 5),
    unsure: yield* save("Crypto prices in USD.", 4, { kind: "preference" }),
    tea: yield* save("Favourite drink is green tea.", 20),
    pasta: yield* save("Cooks 90 g of dry pasta per portion.", 20),
    flooring: yield* save("Home is mostly hard flooring with one carpet.", 20),
    watch: yield* save("Owns a Garmin Venu 3 watch.", 20),
    privateNote: yield* save("Dev team models (bot-a's own copy): everyone on Sonnet.", 6, {
      scope: "bot",
    }),
    teamNote: yield* save("Dev team models (team copy): everyone on Sonnet.", 6, { scope: "team" }),
  };
});

const answers = (ref: (needle: string) => string): TidyJudgeOutput["decisions"] => [
  { action: "supersede", memoryIds: [ref("27 Sep")], by: ref("1 Oct"), reason: "Newer list." },
  {
    action: "merge",
    memoryIds: [ref("per bot"), ref("in total")],
    content: "At most 5 bots run at once in total, across all bots.",
    reason: "Same rule, clarified.",
  },
  { action: "supersede", memoryIds: [ref("being built")], by: null, reason: "1.47.3 shipped." },
  { action: "leave", memoryIds: [ref("Crypto")], reason: "Not sure it is still true." },
  // A ref the model invented, e.g. for an entry it was never shown.
  { action: "supersede", memoryIds: ["E77"], by: ref("1 Oct"), reason: "Hallucinated." },
];

const countRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly total: number; readonly deleted: number }>`
    SELECT COUNT(*) AS "total", SUM(deleted_at IS NOT NULL) AS "deleted" FROM personal_memory
  `;
  return rows[0]!;
});

it.effect(
  "a run archives older entries for newer ones, lists the rest for approval, never deletes",
  () =>
    Effect.gen(function* () {
      prompts.length = 0;
      const ids = yield* seed;
      const memory = yield* PersonalMemoryService;
      const tidy = yield* PersonalMemoryTidy;
      const before = yield* countRows;

      const run = yield* tidy.run({ dryRun: false });
      expect(run.status).toBe("done");
      expect(run.superseded).toBe(1);
      expect(run.pending).toBe(2);

      // Done on its own: the older model list, archived for the newer one, word for word.
      const archived = yield* memory.list({ status: "superseded" });
      expect(archived.map((entry) => entry.memoryId)).toEqual([ids.oldModels]);
      expect(archived[0]!.supersededBy).toBe(ids.newModels);
      const current = (yield* memory.list({})).map((entry) => entry.memoryId);
      expect(current).toContain(ids.newModels);
      // Waiting for the owner: the merge and the retirement change nothing yet.
      expect(current).toEqual(expect.arrayContaining([ids.capA, ids.capB, ids.building]));
      const byStatus = Object.groupBy(run.changes, (change) => change.status);
      expect(byStatus.applied?.length).toBe(1);
      expect(byStatus.pending?.map((change) => change.action)).toEqual(["merge", "supersede"]);
      // Left alone and listed: the unsure one and the invented ref.
      expect(byStatus.left?.map((change) => change.reason)).toEqual([
        "Not sure it is still true.",
        "Names an entry that is not in the list (Hallucinated.)",
      ]);

      // Never deletes; nothing new until a merge is approved.
      expect(yield* countRows).toEqual(before);

      // Bot and team entries are never shown to the model nor changed.
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).not.toContain("bot-a's own copy");
      expect(prompts[0]).not.toContain("team copy");
      expect(current).toEqual(expect.arrayContaining([ids.privateNote, ids.teamNote]));
    }).pipe(Effect.provide(testLayer(fakeJudge(answers)))),
);

it.effect("approving a merge makes one entry and archives both; rejecting is not asked again", () =>
  Effect.gen(function* () {
    const ids = yield* seed;
    const memory = yield* PersonalMemoryService;
    const tidy = yield* PersonalMemoryTidy;
    const run = yield* tidy.run({ dryRun: false });
    const merge = run.changes.find((change) => change.action === "merge")!;
    const retire = run.changes.find(
      (change) => change.status === "pending" && change.action === "supersede",
    )!;

    yield* tidy.decide({ changeId: merge.changeId, approve: true });
    const current = yield* memory.list({});
    const merged = current.find((entry) =>
      entry.content.startsWith("At most 5 bots run at once in total, across"),
    );
    expect(merged?.kind).toBe("preference");
    expect(current.map((entry) => entry.memoryId)).not.toContain(ids.capA);
    expect(current.map((entry) => entry.memoryId)).not.toContain(ids.capB);
    const archived = yield* memory.list({ status: "superseded" });
    expect(archived.find((entry) => entry.memoryId === ids.capA)?.supersededBy).toBe(
      merged!.memoryId,
    );

    // Restore still works on what the tidy-up archived.
    yield* memory.restore({ memoryId: ids.capA });
    expect((yield* memory.list({})).map((entry) => entry.memoryId)).toContain(ids.capA);

    yield* tidy.decide({ changeId: retire.changeId, approve: false });
    expect((yield* memory.list({})).map((entry) => entry.memoryId)).toContain(ids.building);
    const again = yield* tidy.run({ dryRun: false });
    expect(
      again.changes.filter(
        (change) => change.status === "pending" && change.action === "supersede",
      ),
    ).toEqual([]);
    const error = yield* Effect.flip(tidy.decide({ changeId: retire.changeId, approve: true }));
    expect(error.message).toContain("not waiting");
  }).pipe(Effect.provide(testLayer(fakeJudge(answers)))),
);

it.effect("a preview lists everything and changes nothing", () =>
  Effect.gen(function* () {
    yield* seed;
    const memory = yield* PersonalMemoryService;
    const tidy = yield* PersonalMemoryTidy;
    const before = yield* memory.list({});
    const run = yield* tidy.run({ dryRun: true });
    expect(run.dryRun).toBe(true);
    expect(run.changes.map((change) => change.status).toSorted()).toEqual([
      "left",
      "left",
      "pending",
      "pending",
      "preview",
    ]);
    expect(yield* memory.list({})).toEqual(before);
    expect(yield* memory.list({ status: "superseded" })).toEqual([]);
    expect((yield* tidy.log({})).mode).toBe("preview");
  }).pipe(Effect.provide(testLayer(fakeJudge(answers)))),
);

it.effect("a model error fails the run and changes nothing", () =>
  Effect.gen(function* () {
    yield* seed;
    const memory = yield* PersonalMemoryService;
    const tidy = yield* PersonalMemoryTidy;
    const run = yield* tidy.run({ dryRun: false });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("usage limit");
    expect(yield* memory.list({ status: "superseded" })).toEqual([]);
  }).pipe(
    Effect.provide(
      testLayer(
        Layer.succeed(PersonalMemoryTidyJudge, {
          model: "fake-model",
          judge: () => Effect.fail("Claude CLI command failed: usage limit"),
        }),
      ),
    ),
  ),
);
