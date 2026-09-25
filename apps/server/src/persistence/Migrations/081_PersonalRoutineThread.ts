import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The chat a routine was created from. A bot that calls create_routine in a
 * chat gets each run posted back into that chat (`thread_id`), unless it asked
 * for a new chat every run (`new_chat_each_run`). Existing routines keep NULL
 * and 0, so they open a new chat per run exactly as before.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE personal_routines ADD COLUMN thread_id TEXT`;
  yield* sql`
    ALTER TABLE personal_routines
    ADD COLUMN new_chat_each_run INTEGER NOT NULL DEFAULT 0
    CHECK (new_chat_each_run IN (0, 1))
  `;
});
