import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * "Outdated" and "not relevant" marks (personal_memory_feedback) only matter
 * while an entry is current. When an entry is forgotten, removed, or
 * superseded, its mark goes with it, so a restored or replaced entry does not
 * carry a verdict about text that no longer stands. Triggers do it, so every
 * path (the memory screen, the tools, the tidy-up) is covered. Marks left
 * behind by earlier changes are cleared once.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS personal_memory_feedback_on_delete
    AFTER DELETE ON personal_memory
    BEGIN
      DELETE FROM personal_memory_feedback WHERE memory_id = OLD.memory_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS personal_memory_feedback_on_forget
    AFTER UPDATE OF deleted_at ON personal_memory
    WHEN NEW.deleted_at IS NOT NULL
    BEGIN
      DELETE FROM personal_memory_feedback WHERE memory_id = NEW.memory_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS personal_memory_feedback_on_supersede
    AFTER UPDATE OF superseded_at ON personal_memory
    WHEN NEW.superseded_at IS NOT NULL
    BEGIN
      DELETE FROM personal_memory_feedback WHERE memory_id = NEW.memory_id;
    END
  `;

  yield* sql`
    DELETE FROM personal_memory_feedback
    WHERE memory_id NOT IN (
      SELECT memory_id FROM personal_memory
      WHERE deleted_at IS NULL AND superseded_at IS NULL
    )
  `;
});
