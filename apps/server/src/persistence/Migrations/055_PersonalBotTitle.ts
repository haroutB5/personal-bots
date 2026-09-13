import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Seeded bots get their default role labels; user-created bots start untitled.
const SEED_TITLES: ReadonlyArray<readonly [string, string]> = [
  ["personal-seed-assistant", "Personal assistant"],
  ["personal-seed-developer", "Engineer"],
  ["personal-seed-researcher", "Research analyst"],
  ["personal-seed-planner", "Planner"],
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(personal_bots)
  `;

  if (!columns.some((column) => column.name === "title")) {
    yield* sql`
      ALTER TABLE personal_bots
      ADD COLUMN title TEXT NOT NULL DEFAULT ''
    `;
  }

  for (const [botId, title] of SEED_TITLES) {
    yield* sql`
      UPDATE personal_bots
      SET title = ${title}
      WHERE bot_id = ${botId}
        AND title = ''
    `;
  }
});
