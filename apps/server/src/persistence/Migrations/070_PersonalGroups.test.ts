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

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("070_PersonalGroups", (it) => {
  it.effect("creates the group, round and vote tables with their indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'personal_group%'
      `;
      assert.deepEqual(before, []);

      yield* runMigrations({ toMigrationInclusive: 70 });

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

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'idx_personal_group%'
        ORDER BY name ASC
      `;
      assert.deepEqual(
        indexes.map((row) => row.name),
        [
          "idx_personal_group_members_bot",
          "idx_personal_group_messages_group_seq",
          "idx_personal_group_rounds_claim",
          "idx_personal_group_rounds_group",
          "idx_personal_group_votes_round_status",
        ],
      );
    }),
  );

  it.effect("keeps one group per thread and one membership row per bot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });

      yield* insertGroup(sql, "group-1", "thread-group-1");

      // A group thread belongs to exactly one group: the UNIQUE thread_id is
      // what stops a second group adopting a transcript that is already in use.
      yield* refuses(insertGroup(sql, "group-2", "thread-group-1"));

      yield* sql`
        INSERT INTO personal_group_members (group_id, bot_id, joined_at)
        VALUES ('group-1', 'bot-a', ${AT})
      `;
      yield* refuses(sql`
        INSERT INTO personal_group_members (group_id, bot_id, joined_at)
        VALUES ('group-1', 'bot-a', ${AT})
      `);

      // A never-created member thread costs nothing, and a fresh member has
      // seen nothing yet, so its first catch-up starts from the top.
      const members = yield* sql<{
        readonly thread_id: string | null;
        readonly role: string;
        readonly delivered_seq: number;
        readonly sort_order: number;
      }>`
        SELECT thread_id, role, delivered_seq, sort_order FROM personal_group_members
      `;
      assert.deepEqual(members, [
        { thread_id: null, role: "member", delivered_seq: 0, sort_order: 0 },
      ]);
    }),
  );

  it.effect("numbers group messages in arrival order and logs each message once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      yield* insertGroup(sql, "group-msg", "thread-group-msg");

      for (const [messageId, kind, botId] of [
        ["message-1", "user", null],
        ["message-2", "bot", "bot-a"],
        ["message-3", "system", null],
      ] as const) {
        yield* sql`
          INSERT INTO personal_group_messages (
            group_id, message_id, speaker_kind, speaker_bot_id, round_id, created_at
          ) VALUES ('group-msg', ${messageId}, ${kind}, ${botId}, 'round-1', ${AT})
        `;
      }

      const rows = yield* sql<{ readonly seq: number; readonly message_id: string }>`
        SELECT seq, message_id FROM personal_group_messages ORDER BY seq ASC
      `;
      assert.deepEqual(rows, [
        { seq: 1, message_id: "message-1" },
        { seq: 2, message_id: "message-2" },
        { seq: 3, message_id: "message-3" },
      ]);

      // One row per message: the text itself lives in projection_thread_messages.
      yield* refuses(sql`
        INSERT INTO personal_group_messages (
          group_id, message_id, speaker_kind, created_at
        ) VALUES ('group-msg', 'message-2', 'bot', ${AT})
      `);
    }),
  );

  it.effect("gives a round claimable defaults and a vote one ballot per bot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      yield* insertGroup(sql, "group-round", "thread-group-round");
      yield* insertRound(sql, "round-1", "group-round");

      // available_at NULL means claimable now; the queue starts empty and no
      // lease is held until a worker takes one.
      const rounds = yield* sql<{
        readonly queue_json: string;
        readonly spoken_json: string;
        readonly relayed_chars: number;
        readonly available_at: string | null;
        readonly lease_owner: string | null;
      }>`
        SELECT queue_json, spoken_json, relayed_chars, available_at, lease_owner
        FROM personal_group_rounds
      `;
      assert.deepEqual(rounds, [
        {
          queue_json: "[]",
          spoken_json: "[]",
          relayed_chars: 0,
          available_at: null,
          lease_owner: null,
        },
      ]);

      yield* sql`
        INSERT INTO personal_group_votes (
          vote_id, group_id, round_id, called_by_bot_id, question, question_normalised,
          options_json, status, created_at
        ) VALUES (
          'vote-1', 'group-round', 'round-1', 'bot-a', 'Ship it?', 'ship it',
          '["yes","no"]', 'open', ${AT}
        )
      `;

      const votes = yield* sql<{
        readonly status: string;
        readonly winning_option: string | null;
        readonly decided_at: string | null;
      }>`
        SELECT status, winning_option, decided_at FROM personal_group_votes
      `;
      assert.deepEqual(votes, [{ status: "open", winning_option: null, decided_at: null }]);

      yield* sql`
        INSERT INTO personal_group_vote_ballots (vote_id, bot_id, option, reason, created_at)
        VALUES ('vote-1', 'bot-a', 'yes', 'Tests pass.', ${AT})
      `;
      // One ballot per bot per vote is a primary key, not a read-then-write in
      // the tool handler: a second cast_vote from the same bot cannot land.
      yield* refuses(sql`
        INSERT INTO personal_group_vote_ballots (vote_id, bot_id, option, reason, created_at)
        VALUES ('vote-1', 'bot-a', 'no', 'Changed my mind.', ${AT})
      `);

      const ballots = yield* sql<{ readonly option: string }>`
        SELECT option FROM personal_group_vote_ballots
      `;
      assert.deepEqual(ballots, [{ option: "yes" }]);
    }),
  );
});
