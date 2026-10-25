import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getPaths } from "../lib/paths.mjs";
import { backupRoot } from "../lib/backup.mjs";

const snapshotScript = path.resolve(import.meta.dirname, "..", "..", "sqlite-snapshot.cjs");

function makeRoot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-backup-"));
  const paths = getPaths({ home });
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const db = new DatabaseSync(path.join(paths.stateDir, "state.sqlite"));
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  db.exec("INSERT INTO notes (body) VALUES ('keep me')");
  db.close();
  fs.mkdirSync(path.join(paths.stateDir, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, "attachments", "a.txt"), "attachment");
  fs.writeFileSync(path.join(paths.stateDir, "settings.json"), "{}");
  fs.mkdirSync(path.join(paths.stateDir, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, "secrets", "k.bin"), "never copied");
  return { home, paths };
}

test("backup writes a verified snapshot and never copies secrets", () => {
  const { paths } = makeRoot();
  const result = backupRoot({ paths, keep: 1, snapshotScript });
  const backup = result.target;
  assert.equal(fs.existsSync(path.join(backup, "state.sqlite")), true);
  assert.equal(fs.existsSync(path.join(backup, "state.sqlite.integrity.json")), true);
  assert.equal(fs.existsSync(path.join(backup, "backup.json")), true);
  assert.equal(fs.existsSync(path.join(backup, "secrets")), false);
  assert.equal(fs.existsSync(path.join(backup, "attachments", "a.txt")), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, "backup.json"), "utf8"));
  assert.equal(manifest.root, "dev");
  assert.ok(manifest.validation.sha256);
  const copy = new DatabaseSync(path.join(backup, "state.sqlite"), { readOnly: true });
  const row = copy.prepare("SELECT body FROM notes").get();
  copy.close();
  assert.equal(row.body, "keep me");
});

test("retention keeps the newest backup only", async () => {
  const { paths } = makeRoot();
  const first = backupRoot({ paths, keep: 1, snapshotScript });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = backupRoot({ paths, keep: 1, snapshotScript });
  assert.notEqual(first.target, second.target);
  assert.equal(fs.existsSync(first.target), false);
  assert.equal(fs.existsSync(second.target), true);
});

test("a missing database fails before creating a folder", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-backup-empty-"));
  const paths = getPaths({ home });
  fs.mkdirSync(paths.stateDir, { recursive: true });
  assert.throws(() => backupRoot({ paths, snapshotScript }), /No database/);
  assert.equal(fs.existsSync(paths.backupsDir), false);
});
