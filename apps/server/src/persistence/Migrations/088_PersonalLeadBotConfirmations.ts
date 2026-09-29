import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Team-lead follow-ups (1.57). Additive only.
 *
 *  - personal_lead_bot_confirmations: a lead's request to remove or rewrite a bot it does not
 *    own, waiting for the owner's tap on a card in the lead's chat.
 *  - personal_lead_bot_actions.confirmation_id: links the audit row of an approved change to
 *    the request that the owner approved.
 *  - personal_bot_team_moves (+ trigger on personal_bots.team): every team change, whichever
 *    path made it (the form, the Team screen drag, a sync), so a bot a lead created and the
 *    owner later moved is no longer "fully the lead's".
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE personal_lead_bot_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      lead_bot_id TEXT NOT NULL,
      lead_name TEXT NOT NULL,
      team TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('update', 'remove')),
      target_bot_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      -- The lead's chat: the card is shown there and the answer is sent there.
      thread_id TEXT NOT NULL,
      -- What would be applied: an update's resolved patch, or a removal's reason.
      payload_json TEXT NOT NULL,
      -- sha256 of {botId, action, values}: what a tap is bound to.
      change_hash TEXT NOT NULL,
      -- The target's current values of every field being changed (or, for a removal,
      -- its name and team): the change is refused if the bot moved on since.
      base_json TEXT NOT NULL,
      -- Server-written lines the card shows, as a JSON array of strings.
      lines_json TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'approved', 'declined', 'expired', 'failed', 'superseded')
      ),
      outcome TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX idx_personal_lead_bot_confirmations_status
    ON personal_lead_bot_confirmations (status, expires_at)
  `;
  yield* sql`
    CREATE INDEX idx_personal_lead_bot_confirmations_thread
    ON personal_lead_bot_confirmations (thread_id, created_at)
  `;

  yield* sql`ALTER TABLE personal_lead_bot_actions ADD COLUMN confirmation_id TEXT`;

  yield* sql`
    CREATE TABLE personal_bot_team_moves (
      move_id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      from_team TEXT,
      to_team TEXT,
      moved_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_personal_bot_team_moves_bot ON personal_bot_team_moves (bot_id, moved_at)
  `;
  yield* sql`
    CREATE TRIGGER personal_bots_team_moved
    AFTER UPDATE OF team ON personal_bots
    WHEN OLD.team IS NOT NEW.team
    BEGIN
      INSERT INTO personal_bot_team_moves (bot_id, from_team, to_team, moved_at)
      VALUES (NEW.bot_id, OLD.team, NEW.team, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END
  `;
});
