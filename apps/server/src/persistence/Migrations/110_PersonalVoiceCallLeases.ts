import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Voice-call leases (Harout, 15 Oct 2026). Additive only.
 *
 * One row per call that is open **right now**. The server already keeps its
 * open calls in memory, but both restart gates (the release waiter's
 * `idle-classification` and the nightly Updates pipeline) read the state
 * database from their own process, where memory is invisible: without this
 * table a landing could restart the app in the middle of a call.
 *
 * The row is written when a call is minted and removed when it finishes. The
 * server also clears every row at boot, because a restart ends every call, and
 * `expires_at` (the call cap plus a short slack) bounds a row whose phone died
 * and never reported back. It holds ids and timestamps only, never any word
 * said on the call.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE personal_voice_call_leases (
      call_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX personal_voice_call_leases_expires_at
    ON personal_voice_call_leases (expires_at)
  `;
});
