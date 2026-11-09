import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import { getPaths } from "../lib/paths.mjs";
import { backupRoot } from "../lib/backup.mjs";

const snapshotScript = NodePath.resolve(import.meta.dirname, "..", "..", "sqlite-snapshot.cjs");

function makeV2Database(file, maxMigration) {
  const db = new NodeSqlite.DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY)");
  for (let id = 1; id <= maxMigration; id++)
    db.prepare("INSERT INTO effect_sql_migrations VALUES (?)").run(id);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  db.exec("INSERT INTO notes (body) VALUES ('v2 only')");
  db.close();
}

function sha256(file) {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
}

const homes = [];
NodeTest.after(() => {
  for (const home of homes) NodeFS.rmSync(home, { recursive: true, force: true });
});

function makeRoot() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-backup-"));
  homes.push(home);
  const paths = getPaths({ home });
  NodeFS.mkdirSync(paths.stateDir, { recursive: true });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(paths.stateDir, "state.sqlite"));
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  db.exec("INSERT INTO notes (body) VALUES ('keep me')");
  db.close();
  NodeFS.mkdirSync(NodePath.join(paths.stateDir, "attachments"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(paths.stateDir, "attachments", "a.txt"), "attachment");
  NodeFS.writeFileSync(NodePath.join(paths.stateDir, "settings.json"), "{}");
  NodeFS.mkdirSync(NodePath.join(paths.stateDir, "secrets"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(paths.stateDir, "secrets", "k.bin"), "never copied");
  return { home, paths };
}

NodeTest.test("backup writes a verified snapshot and never copies secrets", () => {
  const { paths } = makeRoot();
  const result = backupRoot({ paths, keep: 1, snapshotScript });
  const backup = result.target;
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(backup, "state.sqlite")), true);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(backup, "state.sqlite.integrity.json")), true);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(backup, "backup.json")), true);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(backup, "secrets")), false);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(backup, "attachments", "a.txt")), true);
  const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(backup, "backup.json"), "utf8"));
  NodeAssert.equal(manifest.root, "dev");
  NodeAssert.ok(manifest.validation.sha256);
  const copy = new NodeSqlite.DatabaseSync(NodePath.join(backup, "state.sqlite"), {
    readOnly: true,
  });
  const row = copy.prepare("SELECT body FROM notes").get();
  copy.close();
  NodeAssert.equal(row.body, "keep me");
});

NodeTest.test(
  "a root with state.sqlite and statev2.sqlite backs up both with a manifest entry each",
  () => {
    const { paths } = makeRoot();
    makeV2Database(NodePath.join(paths.stateDir, "statev2.sqlite"), 70);
    const result = backupRoot({ paths, keep: 1, snapshotScript });
    const backup = result.target;
    const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(backup, "backup.json"), "utf8"));
    NodeAssert.deepEqual(Object.keys(manifest.databases), ["state.sqlite", "statev2.sqlite"]);
    for (const name of ["state.sqlite", "statev2.sqlite"]) {
      const file = NodePath.join(backup, name);
      NodeAssert.equal(manifest.databases[name].sha256, sha256(file));
      NodeAssert.equal(manifest.databases[name].bytes, NodeFS.statSync(file).size);
      NodeAssert.equal(manifest.databases[name].ic, "ok");
    }
    NodeAssert.equal(manifest.databases["state.sqlite"].mig, null);
    NodeAssert.equal(manifest.databases["statev2.sqlite"].mig, 70);
    NodeAssert.equal(manifest.validation.sha256, sha256(NodePath.join(backup, "state.sqlite")));
    NodeAssert.deepEqual(result.items.slice(0, 2), ["state.sqlite", "statev2.sqlite"]);
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(backup, "statev2.sqlite-wal")), false);
    const copy = new NodeSqlite.DatabaseSync(NodePath.join(backup, "statev2.sqlite"), {
      readOnly: true,
    });
    const row = copy.prepare("SELECT body FROM notes").get();
    copy.close();
    NodeAssert.equal(row.body, "v2 only");
  },
);

NodeTest.test("a root with only state.sqlite lists only state.sqlite", () => {
  const { paths } = makeRoot();
  const result = backupRoot({ paths, keep: 1, snapshotScript });
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(result.target, "backup.json"), "utf8"),
  );
  NodeAssert.deepEqual(Object.keys(manifest.databases), ["state.sqlite"]);
  NodeAssert.equal(
    manifest.databases["state.sqlite"].sha256,
    sha256(NodePath.join(result.target, "state.sqlite")),
  );
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(result.target, "statev2.sqlite")), false);
  NodeAssert.deepEqual(result.items, ["state.sqlite", "attachments", "settings.json"]);
});

NodeTest.test("retention keeps the newest backup only", async () => {
  const { paths } = makeRoot();
  const first = backupRoot({ paths, keep: 1, snapshotScript });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = backupRoot({ paths, keep: 1, snapshotScript });
  NodeAssert.notEqual(first.target, second.target);
  NodeAssert.equal(NodeFS.existsSync(first.target), false);
  NodeAssert.equal(NodeFS.existsSync(second.target), true);
});

NodeTest.test("a missing database fails before creating a folder", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-backup-empty-"));
  homes.push(home);
  const paths = getPaths({ home });
  NodeFS.mkdirSync(paths.stateDir, { recursive: true });
  NodeAssert.throws(() => backupRoot({ paths, snapshotScript }), /No database/);
  NodeAssert.equal(NodeFS.existsSync(paths.backupsDir), false);
});
