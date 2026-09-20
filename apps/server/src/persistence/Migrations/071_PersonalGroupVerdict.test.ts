import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-09-19T00:00:00.000Z";

const insertGroup = (sql: SqlClient.SqlClient, groupId: string, threadId: string) => sql`
  INSERT INTO personal_groups (group_id, name, thread_id, max_bot_turns, created_at, updated_at)
  VALUES (${groupId}, 'Standup', ${threadId}, 6, ${AT}, ${AT})
`;

const insertRound = (sql: SqlClient.SqlClient, roundId: string, groupId: string) => sql`
  INSERT INTO personal_group_rounds (
    round_id, group_id, trigger_message_id, status, budget_remaining,
    deadline_at, created_at, updated_at
  ) VALUES (
    ${roundId}, ${groupId}, 'message-trigger', 'running', 6,
    '2026-09-19T00:10:00.000Z', ${AT}, ${AT}
  )
`;

/** The statement failed instead of writing the row. */
const refuses = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    assert.equal(result._tag, "Failure");
  });

// One in-memory database is shared by every test in the layer, so each test
// owns its own group and round ids and reads only its own rows.
const roundColumns = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly dflt_value: string | null;
    // "notnull" is an SQLite operator, so the column has to be quoted here.
  }>`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('personal_group_rounds')`;

it.layer(NodeSqliteClient.layerMemory())("071_PersonalGroupVerdict", (it) => {
  it.effect("adds one nullable verdict_bot_id column to the rounds table and nothing else", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });

      const before = yield* roundColumns(sql);
      assert.equal(
        before.some((row) => row.name === "verdict_bot_id"),
        false,
      );

      yield* runMigrations({ toMigrationInclusive: 71 });

      const after = yield* roundColumns(sql);
      const added = after.filter((row) => !before.some((old) => old.name === row.name));
      // NULL means "no member has been asked for the final verdict yet", which
      // is what every round written before this migration has to read as.
      assert.deepEqual(added, [
        { name: "verdict_bot_id", type: "TEXT", notnull: 0, dflt_value: null },
      ]);
      // The column is appended, so existing positional reads keep working.
      assert.equal(after.at(-1)?.name, "verdict_bot_id");

      // No other group table is touched.
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND (name = 'personal_groups' OR name LIKE 'personal_group_%')
        ORDER BY name ASC
      `;
      assert.deepEqual(
        tables.map((row) => row.name),
        [
          "personal_group_members",
          "personal_group_messages",
          "personal_group_rounds",
          "personal_group_vote_ballots",
          "personal_group_votes",
          "personal_groups",
        ],
      );
    }),
  );

  it.effect("leaves rows written before it intact, reading as no verdict speaker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      yield* insertGroup(sql, "group-legacy", "thread-group-legacy");
      yield* insertRound(sql, "round-legacy", "group-legacy");
      yield* sql`
        INSERT INTO personal_group_members (group_id, bot_id, joined_at)
        VALUES ('group-legacy', 'bot-a', ${AT})
      `;

      yield* runMigrations({ toMigrationInclusive: 71 });

      const rounds = yield* sql<{
        readonly status: string;
        readonly budget_remaining: number;
        readonly verdict_bot_id: string | null;
      }>`
        SELECT status, budget_remaining, verdict_bot_id
        FROM personal_group_rounds WHERE round_id = 'round-legacy'
      `;
      assert.deepEqual(rounds, [{ status: "running", budget_remaining: 6, verdict_bot_id: null }]);

      // The rest of the group rows survive the ALTER untouched.
      const members = yield* sql<{ readonly bot_id: string }>`
        SELECT bot_id FROM personal_group_members WHERE group_id = 'group-legacy'
      `;
      assert.deepEqual(members, [{ bot_id: "bot-a" }]);
    }),
  );

  it.effect("stores the bot that owes the verdict and keeps 070's constraints", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });
      yield* insertGroup(sql, "group-verdict", "thread-group-verdict");
      yield* insertRound(sql, "round-verdict", "group-verdict");

      yield* sql`
        UPDATE personal_group_rounds SET verdict_bot_id = 'bot-a' WHERE round_id = 'round-verdict'
      `;
      const set = yield* sql<{ readonly verdict_bot_id: string | null }>`
        SELECT verdict_bot_id FROM personal_group_rounds WHERE round_id = 'round-verdict'
      `;
      assert.deepEqual(set, [{ verdict_bot_id: "bot-a" }]);

      // Clearing it is how a round says the verdict turn is done.
      yield* sql`UPDATE personal_group_rounds SET verdict_bot_id = NULL WHERE round_id = 'round-verdict'`;
      const cleared = yield* sql<{ readonly verdict_bot_id: string | null }>`
        SELECT verdict_bot_id FROM personal_group_rounds WHERE round_id = 'round-verdict'
      `;
      assert.deepEqual(cleared, [{ verdict_bot_id: null }]);

      // The ALTER did not rebuild the table, so 070's keys still hold.
      yield* refuses(insertGroup(sql, "group-verdict-other", "thread-group-verdict"));
      yield* refuses(insertRound(sql, "round-verdict", "group-verdict"));
    }),
  );
});
