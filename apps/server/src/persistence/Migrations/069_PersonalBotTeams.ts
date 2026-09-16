import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Two bot teams, each with one lead, and a Chats pin.
 *
 * The owner's bots split into a dev team the CTO leads and the assistant's
 * team the Assistant leads; delegation is scoped to the caller's own team
 * (see the bots toolkit). Teams are assigned here by name because the bots are
 * the owner's own rows, not seeded ids — a name that is not on either list
 * keeps the column default (assistant's team, not a lead), and a name that is
 * missing entirely simply matches nothing.
 *
 * The column is `is_lead`, not `lead`, so the column name is never confused
 * with SQL's `lead` window function in a hand-written query.
 */

/** Matched case-insensitively against the trimmed bot name. */
export const DEV_TEAM_LEAD_NAME = "cto";
export const ASSISTANT_TEAM_LEAD_NAME = "assistant";
export const DEV_TEAM_MEMBER_NAMES = ["frontend", "backend", "devops", "qa", "security"] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_bots
    ADD COLUMN team TEXT NOT NULL DEFAULT 'assistant'
  `;

  yield* sql`
    ALTER TABLE personal_bots
    ADD COLUMN is_lead INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    ALTER TABLE personal_bots
    ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    UPDATE personal_bots
    SET team = 'dev'
    WHERE lower(trim(name)) IN ('cto', 'frontend', 'backend', 'devops', 'qa', 'security')
  `;

  // The two heads: each leads its own team, and both start pinned to the top
  // of Chats so the owner reaches them in one tap.
  yield* sql`
    UPDATE personal_bots
    SET is_lead = 1, pinned = 1
    WHERE lower(trim(name)) IN ('cto', 'assistant')
  `;
});
