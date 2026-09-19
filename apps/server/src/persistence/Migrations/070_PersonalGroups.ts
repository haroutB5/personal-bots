import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Group chats: a shared orchestration thread everyone reads, plus N member
 * bots that each keep their own provider thread.
 *
 * The group's transcript is NOT stored here. Message text lives exactly once,
 * in `projection_thread_messages` on the group's own thread; these tables hold
 * order, attribution and the restartable state of a round. That keeps the
 * whole chat UI (paging, subscriptions, revert) working unchanged, and leaves
 * a future move to a private store as a copy rather than a rewrite.
 *
 * `personal_groups.thread_id` is UNIQUE and gets no `personal_bot_threads` row:
 * a group thread is deliberately not a bot thread, so no persona is injected
 * into it and no provider ever runs on it.
 *
 * `max_bot_turns` is frozen per group the way `max_depth` / `max_children` are
 * frozen on a root task, so a group created under one budget keeps it across
 * restarts and later default changes.
 *
 * The member cap (6) is a contract constant, not a schema constraint: it is a
 * cost rail the picker and the service enforce, and a schema check would make
 * raising it a migration.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_groups (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      thread_id TEXT NOT NULL UNIQUE,
      max_bot_turns INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT
    )
  `;

  // role is 'member' | 'coordinator'; v1 only ever writes 'member', and the
  // column exists so the v2 coordinator needs no migration.
  // delivered_seq is the catch-up cursor: the highest group seq this member has
  // been shown. thread_id stays NULL until the member first speaks, so a member
  // that never speaks costs no provider thread at all.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_group_members (
      group_id TEXT NOT NULL REFERENCES personal_groups(group_id),
      bot_id TEXT NOT NULL,
      thread_id TEXT UNIQUE,
      role TEXT NOT NULL DEFAULT 'member',
      sort_order INTEGER NOT NULL DEFAULT 0,
      delivered_seq INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT NOT NULL,
      left_at TEXT,
      PRIMARY KEY (group_id, bot_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_group_members_bot
    ON personal_group_members(bot_id)
  `;

  // Order and attribution only. `seq` is an explicit INTEGER PRIMARY KEY so it
  // is the rowid and orders the whole log; `message_id` points at the one row
  // in projection_thread_messages that holds the text.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_group_messages (
      seq INTEGER PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES personal_groups(group_id),
      message_id TEXT NOT NULL UNIQUE,
      speaker_kind TEXT NOT NULL,
      speaker_bot_id TEXT,
      round_id TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_group_messages_group_seq
    ON personal_group_messages(group_id, seq)
  `;

  // One round per user message, holding everything needed to resume or abandon
  // an in-flight relay after a restart. available_at gates rate-limited
  // backoff (NULL means claimable now); the lease columns are the same
  // single-owner pattern the task system uses.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_group_rounds (
      round_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES personal_groups(group_id),
      trigger_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      budget_remaining INTEGER NOT NULL,
      queue_json TEXT NOT NULL DEFAULT '[]',
      spoken_json TEXT NOT NULL DEFAULT '[]',
      active_bot_id TEXT,
      active_thread_id TEXT,
      active_turn_id TEXT,
      active_message_id TEXT,
      relayed_chars INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      available_at TEXT,
      deadline_at TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // The sweep's claim query: non-terminal rounds whose backoff has elapsed.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_group_rounds_claim
    ON personal_group_rounds(status, available_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_group_rounds_group
    ON personal_group_rounds(group_id, created_at DESC)
  `;

  // Voting. A resolved vote never executes on its own: it parks for the
  // owner's Approve / Reject, because these bots hold the shared browser,
  // the saved logins and a shell.
  //
  // question_normalised is the question with case, punctuation and whitespace
  // flattened, so a reworded re-ask of a question already decided in this
  // round matches and is refused.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_group_votes (
      vote_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES personal_groups(group_id),
      round_id TEXT NOT NULL REFERENCES personal_group_rounds(round_id),
      called_by_bot_id TEXT NOT NULL,
      question TEXT NOT NULL,
      question_normalised TEXT NOT NULL,
      options_json TEXT NOT NULL,
      status TEXT NOT NULL,
      winning_option TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    )
  `;

  // "Is a vote already open in this round?" and "what did this round decide?".
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_personal_group_votes_round_status
    ON personal_group_votes(round_id, status)
  `;

  // One ballot per bot per vote, enforced by the primary key rather than by a
  // read-then-write in the tool handler.
  yield* sql`
    CREATE TABLE IF NOT EXISTS personal_group_vote_ballots (
      vote_id TEXT NOT NULL REFERENCES personal_group_votes(vote_id),
      bot_id TEXT NOT NULL,
      option TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (vote_id, bot_id)
    )
  `;
});
