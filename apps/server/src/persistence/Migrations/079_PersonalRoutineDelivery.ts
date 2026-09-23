import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * How a routine's run reaches the user. `model` (every existing routine) gives
 * the prompt to the bot as a task; `relay` posts the text into the bot's chat
 * as its own message without a model turn: the scheduled routine's prompt, or
 * an event payload's `message` field.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE personal_routines
    ADD COLUMN delivery TEXT NOT NULL DEFAULT 'model'
    CHECK (delivery IN ('model', 'relay'))
  `;
});
