// @effect-diagnostics nodeBuiltinImport:off - the test sets the same process environment and platform the migration reads.
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { linuxPathMapMissingMessage, storedWindowsPathInPayload } from "./113_LinuxPathRewrite.ts";
import { runMigrations } from "../Migrations.ts";

const MAP = "C:/Users/Ht=/home/harout;C:/Claude/AI=/home/harout/claude";

/** A fresh in-memory database per suite: each case starts at migration 112. */
const client = () => NodeSqliteClient.layer({ filename: ":memory:" });

/**
 * `process.platform` is read inside the migration, exactly as the real server
 * reads it. The property is configurable, so the test can be the Linux host
 * while the suite itself runs on Windows.
 */
const withPlatform = <A, E, R>(
  platform: NodeJS.Platform,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  return Effect.acquireUseRelease(
    Effect.sync(() =>
      Object.defineProperty(process, "platform", { ...original, value: platform }),
    ),
    () => effect,
    () => Effect.sync(() => Object.defineProperty(process, "platform", original)),
  );
};

const withPathMap = <A, E, R>(
  raw: string | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const previous = process.env.T3CODE_PATH_MAP;
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      if (raw === undefined) delete process.env.T3CODE_PATH_MAP;
      else process.env.T3CODE_PATH_MAP = raw;
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.T3CODE_PATH_MAP;
        else process.env.T3CODE_PATH_MAP = previous;
      }),
  );
};

/** A database shaped by the live one: Windows paths in projects, threads and events. */
const seedWindowsPaths = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 112 });
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, favicon_path)
    VALUES ('p1', 'personal-bots', 'C:/Claude/AI/personal-bots', '[]', '2026-01-01', '2026-01-01',
            'C:/Users/Ht/.personal-bots/dev/userdata/project-icons/p1.png')
  `;
  yield* sql`
    INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, worktree_path, created_at, updated_at, runtime_mode, interaction_mode, pending_approval_count, pending_user_input_count, has_actionable_proposed_plan)
    VALUES ('t1', 'p1', 'worktree', NULL, 'C:\\Claude\\AI\\_wt\\hbots-linux-server', '2026-01-01', '2026-01-01', 'full-access', 'default', 0, 0, 0)
  `;
  yield* sql`
    INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
    VALUES ('e1', 'project', 'p1', 1, 'project.created', '2026-01-01T00:00:00.000Z', 'user',
            '{"workspaceRoot":"C:\\\\Claude\\\\AI\\\\personal-bots","scripts":[]}', '{}')
  `;
});

const latestMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly id: number | null }>`
    SELECT max(migration_id) AS id FROM effect_sql_migrations
  `;
  return rows[0]?.id ?? null;
});

const storedPaths = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* sql<{
    readonly workspace_root: string;
    readonly favicon_path: string | null;
  }>`SELECT workspace_root, favicon_path FROM projection_projects ORDER BY project_id`;
  const threads = yield* sql<{ readonly worktree_path: string | null }>`
    SELECT worktree_path FROM projection_threads ORDER BY thread_id
  `;
  const events = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_events ORDER BY event_id
  `;
  return { projects, threads, events };
});

it.layer(client())("113 fail-safe on Linux", (it) => {
  it.effect("stops the boot with stored Windows paths and no map, and records nothing", () =>
    Effect.gen(function* () {
      yield* seedWindowsPaths;
      const exit = yield* withPlatform(
        "linux",
        withPathMap(undefined, runMigrations({ toMigrationInclusive: 113 })),
      ).pipe(Effect.exit);

      assert.strictEqual(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.ok(error instanceof Error);
        assert.strictEqual(error.name, "LinuxPathMapMissingError");
        assert.match(error.message, /T3CODE_PATH_MAP/);
        // It names a real stored path so the operator knows which data root moved.
        assert.match(error.message, /C:\/Claude\/AI\/personal-bots/);
        assert.match(error.message, /not recorded/);
      }
      // The migration transaction rolled back: 113 is still pending, so the
      // next boot with the variable set rewrites the paths.
      assert.strictEqual(yield* latestMigration, 112);
      const paths = yield* storedPaths;
      assert.strictEqual(paths.projects[0]?.workspace_root, "C:/Claude/AI/personal-bots");
      assert.strictEqual(
        paths.threads[0]?.worktree_path,
        "C:\\Claude\\AI\\_wt\\hbots-linux-server",
      );
    }),
  );
});

it.layer(client())("113 on Linux without Windows paths", (it) => {
  it.effect("boots without the map when the database holds nothing to rewrite", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 112 });
      const exit = yield* withPlatform(
        "linux",
        withPathMap(undefined, runMigrations({ toMigrationInclusive: 113 })),
      ).pipe(Effect.exit);
      assert.strictEqual(Exit.isFailure(exit), false);
      assert.strictEqual(yield* latestMigration, 113);
    }),
  );
});

it.layer(client())("113 on Windows", (it) => {
  it.effect("keeps the no-op exactly as it was, with the map unset", () =>
    Effect.gen(function* () {
      yield* seedWindowsPaths;
      const exit = yield* withPlatform(
        "win32",
        withPathMap(undefined, runMigrations({ toMigrationInclusive: 113 })),
      ).pipe(Effect.exit);
      assert.strictEqual(Exit.isFailure(exit), false);
      assert.strictEqual(yield* latestMigration, 113);
      const paths = yield* storedPaths;
      assert.strictEqual(paths.projects[0]?.workspace_root, "C:/Claude/AI/personal-bots");
      assert.strictEqual(
        paths.threads[0]?.worktree_path,
        "C:\\Claude\\AI\\_wt\\hbots-linux-server",
      );
    }),
  );
});

it.layer(client())("113 with the map", (it) => {
  it.effect("still rewrites on Linux when the map is set", () =>
    Effect.gen(function* () {
      yield* seedWindowsPaths;
      const exit = yield* withPlatform(
        "linux",
        withPathMap(MAP, runMigrations({ toMigrationInclusive: 113 })),
      ).pipe(Effect.exit);
      assert.strictEqual(Exit.isFailure(exit), false);
      assert.strictEqual(yield* latestMigration, 113);
      const paths = yield* storedPaths;
      assert.strictEqual(paths.projects[0]?.workspace_root, "/home/harout/claude/personal-bots");
      assert.strictEqual(
        paths.threads[0]?.worktree_path,
        "/home/harout/claude/_wt/hbots-linux-server",
      );
    }),
  );
});

it("names the columns in the failure and reads paths only from the structural event keys", () => {
  assert.match(
    linuxPathMapMissingMessage([
      { source: "projection_projects.workspace_root", value: "C:/x" },
      { source: "projection_threads.worktree_path", value: "C:\\y" },
    ]),
    /projection_projects\.workspace_root = C:\/x; projection_threads\.worktree_path = C:\\y/,
  );
  assert.strictEqual(
    storedWindowsPathInPayload('{"workspaceRoot":"C:\\\\Claude\\\\AI"}'),
    "C:\\Claude\\AI",
  );
  // Message text is content: never treated as a path to rewrite.
  assert.strictEqual(
    storedWindowsPathInPayload('{"text":"the old path was C:\\\\Claude\\\\AI"}'),
    null,
  );
  assert.strictEqual(storedWindowsPathInPayload('{"workspaceRoot":"/home/harout"}'), null);
  assert.strictEqual(storedWindowsPathInPayload("not json"), null);
});
