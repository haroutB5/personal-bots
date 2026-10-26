// @effect-diagnostics nodeBuiltinImport:off - the test drives a real database file and a real child process.
/**
 * A second process reading a live database must never crash the server.
 *
 * This is the regression guard for the 26 Oct SIGBUS crashes (live server and
 * two throwaways): `walFindFrame`/`readDbPage` died with BUS_ADRERR after
 * another process touched the running server's WAL. The proven triggers were
 * outside the server (a reader opening the live files, and a throwaway root
 * being deleted under the running server), and the app's tooling now copies the
 * database first. The writer here runs the server's own pragmas (WAL,
 * `journal_size_limit`, a PASSIVE checkpoint, NORMAL sync) while a child
 * process opens the file read-only, reads it and closes, repeatedly.
 *
 * If this ever starts failing with SIGBUS, node:sqlite's WAL handling is the
 * cause and the copy-first rule is not enough.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";

const roots: string[] = [];

const liveDatabase = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-live-reader-"));
  roots.push(dir);
  const file = NodePath.join(dir, "state.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA journal_size_limit = 4194304");
  db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, padding TEXT NOT NULL)");
  return { dir, file, db };
};

const reader = (file: string) =>
  NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(${JSON.stringify(file)}, { readOnly: true });
      const rows = db.prepare("SELECT count(*) AS n FROM events").get();
      db.close();
      process.stdout.write(String(rows.n));
    `,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );

afterEach(() => {
  for (const dir of roots.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("a second process reading the live WAL database", () => {
  it("does not stop the writer, across many open/read/close cycles", () => {
    const { file, db } = liveDatabase();
    const insert = db.prepare("INSERT INTO events (padding) VALUES (?)");
    const padding = "x".repeat(4_000);
    try {
      for (let round = 0; round < 60; round += 1) {
        insert.run(padding);
        // Every third round also checkpoints passiver, like the server's worker.
        if (round % 3 === 0) db.exec("PRAGMA wal_checkpoint(PASSIVE)");
        if (round % 5 === 0) {
          const child = reader(file);
          expect(child.status, child.stderr).toBe(0);
          expect(Number(child.stdout)).toBeGreaterThan(0);
        }
      }
      // The writer is still healthy after the readers came and went.
      insert.run(padding);
      const count = db.prepare("SELECT count(*) AS n FROM events").get() as { n: number };
      expect(count.n).toBe(61);
    } finally {
      db.close();
    }
  }, 120_000);
});
