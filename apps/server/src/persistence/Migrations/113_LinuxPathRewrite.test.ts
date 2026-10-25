// @effect-diagnostics nodeBuiltinImport:off - the test sets the same process environment the migration reads.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0113, { parsePathMap } from "./113_LinuxPathRewrite.ts";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const MAP =
  "C:/Users/Ht=/home/harout;C:/Claude/AI=/home/harout/claude;C:/Claude=/home/harout/documents/claude";

/** A database shaped like the live one: the same tables and row types. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 112 });

  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, favicon_path)
    VALUES ('p1', 'personal-bots', 'C:/Claude/AI/personal-bots', '[]', '2026-01-01', '2026-01-01',
            'C:/Users/Ht/.personal-bots/dev/userdata/project-icons/p1.png')
  `;
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('p2', 'elsewhere', 'D:/Games/Mods', '[]', '2026-01-01', '2026-01-01'),
           ('p3', 'already-linux', '/home/harout/keep', '[]', '2026-01-01', '2026-01-01')
  `;
  yield* sql`
    INSERT INTO projection_threads (thread_id, project_id, title, model, worktree_path, created_at, updated_at)
    VALUES ('t1', 'p1', 'worktree', 'claude-opus-5', 'C:\\Claude\\AI\\_wt\\hbots-linux-server', '2026-01-01', '2026-01-01'),
           ('t2', 'p1', 'plain', 'claude-opus-5', NULL, '2026-01-01', '2026-01-01'),
           ('t3', 'p3', 'linux', 'claude-opus-5', '/home/harout/keep', '2026-01-01', '2026-01-01')
  `;

  const event = (id: string, type: string, payload: unknown) => sql`
    INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
    VALUES (${id}, 'project', 'p1', 1, ${type}, '2026-01-01T00:00:00.000Z', 'user',
            ${JSON.stringify(payload)}, '{}')
  `;
  yield* event("e1", "project.created", {
    workspaceRoot: "C:\\Claude\\AI\\personal-bots",
    faviconPath: "C:/Users/Ht/.personal-bots/dev/userdata/project-icons/p1.png",
    scripts: [],
  });
  yield* event("e2", "thread.created", {
    worktreePath: "C:/Claude/AI/_wt/hbots-linux-server",
    projectCwd: "C:/Claude/AI/personal-bots/apps/server",
  });
  // Two rows the migration must not touch: message content and an unmapped root.
  yield* event("e3", "thread.message-sent", {
    text: "the old path was C:/Claude/AI/personal-bots and it stays in history",
  });
  yield* event("e4", "project.meta-updated", { workspaceRoot: "D:/Games/Mods" });
});

const readPaths = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* sql<{
    readonly project_id: string;
    readonly workspace_root: string;
    readonly favicon_path: string | null;
  }>`SELECT project_id, workspace_root, favicon_path FROM projection_projects ORDER BY project_id`;
  const threads = yield* sql<{
    readonly thread_id: string;
    readonly worktree_path: string | null;
  }>`SELECT thread_id, worktree_path FROM projection_threads ORDER BY thread_id`;
  const events = yield* sql<{
    readonly event_id: string;
    readonly event_type: string;
    readonly payload_json: string;
  }>`SELECT event_id, event_type, payload_json FROM orchestration_events ORDER BY event_id`;
  return { projects, threads, events };
});

layer("113_LinuxPathRewrite", (it) => {
  it.effect("rewrites every stored Windows path once, leaves content alone, and does nothing unmapped", () =>
    Effect.gen(function* () {
      yield* seed;
      const previous = process.env.T3CODE_PATH_MAP;
      // First boot on the new machine before the mapping is configured: no-op.
      delete process.env.T3CODE_PATH_MAP;
      yield* runMigrations({ toMigrationInclusive: 113 });
      const unmapped = yield* readPaths;
      assert.strictEqual(unmapped.projects[0]?.workspace_root, "C:/Claude/AI/personal-bots");

      process.env.T3CODE_PATH_MAP = MAP;
      try {
        // A re-run of the migration itself (the mapping was set afterwards).
        yield* Migration0113;
        const first = yield* readPaths;

        assert.deepStrictEqual(
          first.projects.map((row) => [row.project_id, row.workspace_root, row.favicon_path]),
          [
            ["p1", "/home/harout/claude/personal-bots", "/home/harout/.personal-bots/dev/userdata/project-icons/p1.png"],
            ["p2", "D:/Games/Mods", null],
            ["p3", "/home/harout/keep", null],
          ],
        );
        assert.deepStrictEqual(
          first.threads.map((row) => [row.thread_id, row.worktree_path]),
          [
            ["t1", "/home/harout/claude/_wt/hbots-linux-server"],
            ["t2", null],
            ["t3", "/home/harout/keep"],
          ],
        );
        const payload = (id: string) =>
          JSON.parse(first.events.find((row) => row.event_id === id)!.payload_json);
        assert.strictEqual(payload("e1").workspaceRoot, "/home/harout/claude/personal-bots");
        assert.strictEqual(
          payload("e1").faviconPath,
          "/home/harout/.personal-bots/dev/userdata/project-icons/p1.png",
        );
        assert.strictEqual(payload("e2").worktreePath, "/home/harout/claude/_wt/hbots-linux-server");
        assert.strictEqual(payload("e2").projectCwd, "/home/harout/claude/personal-bots/apps/server");
        assert.strictEqual(
          payload("e3").text,
          "the old path was C:/Claude/AI/personal-bots and it stays in history",
        );
        assert.strictEqual(payload("e4").workspaceRoot, "D:/Games/Mods");

        // Longest prefix wins: C:/Claude/AI went to claude/, not documents/claude.
        assert.ok(!first.projects.some((row) => row.workspace_root.includes("documents/claude")));

        // Idempotent: a re-run changes no row.
        yield* Migration0113;
        const second = yield* readPaths;
        assert.deepStrictEqual(second, first);
      } finally {
        if (previous === undefined) delete process.env.T3CODE_PATH_MAP;
        else process.env.T3CODE_PATH_MAP = previous;
      }
    }),
  );

  it.effect("parses a mapping, ignoring malformed entries and keeping the longest first", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        parsePathMap("C:\\Claude\\AI=/home/h/claude;C:/Users/Ht=/home/h;C:/Bad=;D:/x=D:/y"),
        [
          { from: "C:/Users/Ht", to: "/home/h" },
          { from: "C:/Claude/AI", to: "/home/h/claude" },
          { from: "D:/x", to: "D:/y" },
        ],
      );
      assert.deepStrictEqual(parsePathMap(undefined), []);
      assert.deepStrictEqual(parsePathMap("  "), []);
    }),
  );
});
