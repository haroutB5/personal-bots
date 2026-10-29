// @effect-diagnostics nodeBuiltinImport:off - the test sets the same process environment the migration reads.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0114, { rewriteInstructionText } from "./114_LinuxInstructionPaths.ts";
import { parsePathMap } from "./113_LinuxPathRewrite.ts";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const MAP = "C:/Users/Ht=/home/harout;C:/Claude/AI=/home/harout/Claude/AI";
const mappings = parsePathMap(MAP);

const HANDBOOK = "Read C:/Claude/AI/dev-team/HANDBOOK.md and the app sheet before any work.";
const BACKSLASHES = "Report it under C:\\Claude\\AI\\dev-team\\published\\report.html, please.";
const WINDOWS_HOME = "The store is at C:/Users/Ht/.personal-bots/dev/userdata.";
const UNRELATED = "Model bench lives at D:/Bench/runs and the old text says C:/Claude/AIx stays.";

/** A database shaped like the live one, before migration 114 runs. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 113 });

  yield* sql`
    INSERT INTO personal_bots (bot_id, name, description, instructions, avatar_shape, avatar_color, model_selection_json, created_at, updated_at)
    VALUES ('b1', 'Backend', '', ${HANDBOOK}, 'circle', '#111111', '{}', '2026-01-01', '2026-01-01'),
           ('b2', 'Plain', '', 'No paths here.', 'circle', '#222222', '{}', '2026-01-01', '2026-01-01'),
           ('b3', 'Escaped', '', ${BACKSLASHES}, 'circle', '#333333', '{}', '2026-01-01', '2026-01-01')
  `;
  yield* sql`
    INSERT INTO personal_routines (routine_id, bot_id, title, prompt, schedule_json, created_at, updated_at)
    VALUES ('r1', 'b1', 'Nightly', ${WINDOWS_HOME}, '{}', '2026-01-01', '2026-01-01')
  `;
  yield* sql`
    INSERT INTO personal_memory (memory_id, scope, kind, content, source, created_at, updated_at)
    VALUES ('m1', 'shared', 'note', ${UNRELATED}, 'user', '2026-01-01', '2026-01-01'),
           ('m2', 'shared', 'note', ${HANDBOOK}, 'user', '2026-01-01', '2026-01-01')
  `;
});

const read = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bots = yield* sql<{ readonly bot_id: string; readonly instructions: string }>`
    SELECT bot_id, instructions FROM personal_bots ORDER BY bot_id
  `;
  const routines = yield* sql<{ readonly routine_id: string; readonly prompt: string }>`
    SELECT routine_id, prompt FROM personal_routines ORDER BY routine_id
  `;
  const memory = yield* sql<{ readonly memory_id: string; readonly content: string }>`
    SELECT memory_id, content FROM personal_memory ORDER BY memory_id
  `;
  return { bots, routines, memory };
});

layer("114_LinuxInstructionPaths", (it) => {
  it.effect("rewrites paths inside instructions, routines and memory, and leaves prose alone", () =>
    Effect.gen(function* () {
      yield* seed;
      const previous = process.env.T3CODE_PATH_MAP;
      process.env.T3CODE_PATH_MAP = MAP;
      try {
        yield* Migration0114;
        const after = yield* read;
        assert.deepStrictEqual(
          after.bots.map((row) => [row.bot_id, row.instructions]),
          [
            [
              "b1",
              "Read /home/harout/Claude/AI/dev-team/HANDBOOK.md and the app sheet before any work.",
            ],
            ["b2", "No paths here."],
            [
              "b3",
              "Report it under /home/harout/Claude/AI/dev-team/published/report.html, please.",
            ],
          ],
        );
        assert.deepStrictEqual(
          after.routines.map((row) => [row.routine_id, row.prompt]),
          [["r1", "The store is at /home/harout/.personal-bots/dev/userdata."]],
        );
        assert.deepStrictEqual(
          after.memory.map((row) => [row.memory_id, row.content]),
          [
            // A mapped prefix followed by another word is a different folder.
            ["m1", "Model bench lives at D:/Bench/runs and the old text says C:/Claude/AIx stays."],
            [
              "m2",
              "Read /home/harout/Claude/AI/dev-team/HANDBOOK.md and the app sheet before any work.",
            ],
          ],
        );
      } finally {
        if (previous === undefined) delete process.env.T3CODE_PATH_MAP;
        else process.env.T3CODE_PATH_MAP = previous;
      }
    }),
  );

  it.effect("is idempotent: a second run changes nothing", () =>
    Effect.gen(function* () {
      const first = yield* read;
      const previous = process.env.T3CODE_PATH_MAP;
      process.env.T3CODE_PATH_MAP = MAP;
      try {
        yield* Migration0114;
      } finally {
        if (previous === undefined) delete process.env.T3CODE_PATH_MAP;
        else process.env.T3CODE_PATH_MAP = previous;
      }
      assert.deepStrictEqual(yield* read, first);
    }),
  );

  it.effect("never touches a Windows install (no map): everything stays as written", () =>
    Effect.gen(function* () {
      const previous = process.env.T3CODE_PATH_MAP;
      delete process.env.T3CODE_PATH_MAP;
      try {
        yield* Migration0114;
      } finally {
        if (previous !== undefined) process.env.T3CODE_PATH_MAP = previous;
      }
      const after = yield* read;
      assert.strictEqual(after.bots[0]?.instructions.includes("C:/Claude/AI"), false);
    }),
  );

  it("matches either separator, any case, and stops a path at punctuation", () => {
    assert.strictEqual(
      rewriteInstructionText("see c:\\claude\\ai\\reports\\a.md.", mappings),
      "see /home/harout/Claude/AI/reports/a.md.",
    );
    assert.strictEqual(
      rewriteInstructionText("(C:/CLAUDE/AI/x)", mappings),
      "(/home/harout/Claude/AI/x)",
    );
    assert.strictEqual(rewriteInstructionText("no windows path", mappings), null);
  });
});
