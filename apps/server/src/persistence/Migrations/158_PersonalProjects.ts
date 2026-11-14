import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Projects a team lead keeps across tasks. One open project per lead and
 * name (any case), so `update_project` upserts by name. CHECKs mirror the
 * contract. A task links to at most one project through `project_id`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE personal_projects (
      project_id TEXT PRIMARY KEY,
      lead_bot_id TEXT NOT NULL,
      thread_id TEXT,
      name TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      due_at TEXT,
      estimated_at TEXT,
      state TEXT NOT NULL CHECK (state IN ('open', 'done', 'dropped')),
      closed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((due_at IS NULL) = (estimated_at IS NULL)),
      CHECK ((state = 'open') = (closed_at IS NULL))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX ux_personal_projects_open_name
    ON personal_projects(lead_bot_id, lower(name))
    WHERE state = 'open'
  `;
  yield* sql`
    ALTER TABLE personal_tasks ADD COLUMN project_id TEXT
  `;
  yield* sql`
    CREATE INDEX idx_personal_tasks_project
    ON personal_tasks(project_id, updated_at)
    WHERE project_id IS NOT NULL
  `;
});
