// Backup for big releases (a migration change or --force-backup), built for a database that must never be
// opened by a second process while the server runs. The server is STOPPED, the files are reflink-copied
// (btrfs: copy-on-write, a few seconds for 6 GB), the server is started again on the new release, and the copy is
// then checkpointed and integrity-checked at background priority while the new release is already up.
// Nothing here ever opens a live database (state.sqlite, statev2.sqlite) or its -wal/-shm; sizes come from stat only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { run, runAsync, readJson, atomicWrite, round1, sha256File } from "./util.mjs";
import * as NodeURL from "node:url";

const DBCHECK = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "dbcheck.mjs",
);
export const BACKUP_NAME = /^\d{8}-\d{6}$/;
// The v1 database and the one the v2 server writes. The last one present is the live one.
export const DATABASES = ["state.sqlite", "statev2.sqlite"];

const presentDatabases = (dir) =>
  DATABASES.filter((name) => NodeFS.existsSync(NodePath.join(dir, name)));

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Sizes by stat only (no open). */
export function liveSizes(cfg) {
  const size = (f) => {
    try {
      return NodeFS.statSync(NodePath.join(cfg.stateDir, f)).size;
    } catch {
      return 0;
    }
  };
  const total = (suffix) => DATABASES.reduce((sum, name) => sum + size(name + suffix), 0);
  return { db: total(""), wal: total("-wal"), shm: total("-shm") };
}

export function listBackups(cfg) {
  try {
    return NodeFS.readdirSync(cfg.backups, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          BACKUP_NAME.test(d.name) &&
          NodeFS.existsSync(NodePath.join(cfg.backups, d.name, "backup.json")),
      )
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Reflink needs the same filesystem and a filesystem that supports it. Probed in the backups dir only. */
export function reflinkProbe(cfg) {
  NodeFS.mkdirSync(cfg.backups, { recursive: true });
  const same = NodeFS.statSync(cfg.backups).dev === NodeFS.statSync(cfg.stateDir).dev;
  if (!same)
    return { ok: false, reason: "backups and the data folder are on different filesystems" };
  const probe = NodePath.join(cfg.backups, `.reflink-probe-${process.pid}`);
  try {
    NodeFS.writeFileSync(probe, Buffer.alloc(8192, 7));
    const r = run("cp", ["--reflink=always", probe, `${probe}.copy`], { timeout: 15_000 });
    return r.code === 0
      ? { ok: true }
      : { ok: false, reason: r.err.slice(0, 160) || "cp --reflink=always failed" };
  } finally {
    NodeFS.rmSync(probe, { force: true });
    NodeFS.rmSync(`${probe}.copy`, { force: true });
  }
}

export function diskPlan(cfg, reflinkOk, allowSlow) {
  const sizes = liveSizes(cfg);
  const st = NodeFS.statfsSync(cfg.backups);
  const free = st.bavail * st.bsize;
  const need = Math.max(
    2 * 1024 ** 3,
    2 * sizes.wal + (reflinkOk ? 0.05 * sizes.db : 1.2 * sizes.db),
  );
  return { free, need, ok: free >= need && (reflinkOk || allowSlow), sizes };
}

/** Copies the (stopped) data files into destDir. Returns what was copied. */
export function copyStopped(cfg, destDir, { allowSlow = false } = {}) {
  NodeFS.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const mode = allowSlow ? "--reflink=auto" : "--reflink=always";
  const databases = presentDatabases(cfg.stateDir);
  if (databases.length === 0) throw new Error(`no database in ${cfg.stateDir} to back up`);
  const files = [
    ...databases.flatMap((name) => [name, `${name}-wal`, `${name}-shm`]),
    "settings.json",
  ];
  const copied = [];
  for (const name of files) {
    const src = NodePath.join(cfg.stateDir, name);
    if (!NodeFS.existsSync(src)) continue;
    const r = run("cp", [mode, "--preserve=timestamps", src, NodePath.join(destDir, name)], {
      timeout: 600_000,
    });
    if (r.code !== 0) throw new Error(`copy of ${name} failed: ${r.err.slice(0, 200)}`);
    const a = NodeFS.statSync(src).size;
    const b = NodeFS.statSync(NodePath.join(destDir, name)).size;
    if (a !== b) throw new Error(`copy of ${name} has ${b} bytes, the source ${a}`);
    copied.push({ name, bytes: b });
  }
  for (const dir of ["secrets", "attachments"]) {
    const src = NodePath.join(cfg.stateDir, dir);
    if (!NodeFS.existsSync(src)) continue;
    const r = run("cp", ["-a", mode, src, NodePath.join(destDir, dir)], { timeout: 600_000 });
    if (r.code !== 0) throw new Error(`copy of ${dir}/ failed: ${r.err.slice(0, 200)}`);
    copied.push({ name: `${dir}/` });
  }
  for (const name of databases) {
    const head = Buffer.alloc(16);
    const fd = NodeFS.openSync(NodePath.join(destDir, name), "r");
    try {
      NodeFS.readSync(fd, head, 0, 16, 0);
    } finally {
      NodeFS.closeSync(fd);
    }
    if (head.toString("latin1") !== "SQLite format 3\0")
      throw new Error(`the copied ${name} does not start with the SQLite header`);
  }
  return copied;
}

export function writeManifest(destDir, manifest) {
  atomicWrite(NodePath.join(destDir, "backup.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Checkpoint + integrity_check + digest on each database COPY, at idle I/O priority. Updates the manifest.
 * The migration expectation and the returned check are for the live database (the last one present). */
export async function verifyBackup(cfg, destDir, expectMigration) {
  const t0 = Date.now();
  const databases = presentDatabases(destDir);
  if (databases.length === 0) throw new Error(`backup ${destDir} holds no database`);
  const checks = {};
  for (const name of databases) {
    const r = await runAsync(
      cfg.node,
      ["--disable-warning=ExperimentalWarning", DBCHECK, NodePath.join(destDir, name)],
      { low: true, timeoutMs: 60 * 60_000 },
    );
    if (r.code !== 0) throw new Error(`backup check of ${name} failed: ${r.err.slice(0, 300)}`);
    checks[name] = JSON.parse(r.out);
    if (checks[name].ic !== "ok")
      throw new Error(`backup integrity_check of ${name}: ${checks[name].ic}`);
  }
  const check = checks[databases.at(-1)];
  if (expectMigration != null && check.mig !== Number(expectMigration))
    throw new Error(`backup is at migration ${check.mig}; expected ${expectMigration}`);
  const manifest = readJson(NodePath.join(destDir, "backup.json")) ?? {};
  manifest.validation = {
    schema: 1,
    method: "stopped-reflink-copy-integrity-check",
    ic: check.ic,
    mig: check.mig,
    rows: check.rows,
    mem: check.mem,
    bytes: check.bytes,
    sha256: check.sha256,
  };
  manifest.databases = Object.fromEntries(
    databases.map((name) => {
      const { bytes, sha256, ic, mig } = checks[name];
      return [name, { bytes, sha256, ic, mig }];
    }),
  );
  writeManifest(destDir, manifest);
  return { ...check, seconds: round1((Date.now() - t0) / 1000) };
}

/** Checkpoint, integrity-check, digest and manifest entry for ONE database COPY. Used before a compact. */
export async function verifyDatabaseCopy(cfg, destDir, name, expectMigration) {
  const t0 = Date.now();
  const file = NodePath.join(destDir, name);
  if (!NodeFS.existsSync(file)) throw new Error(`backup ${destDir} has no ${name}`);
  const r = await runAsync(
    cfg.node,
    ["--disable-warning=ExperimentalWarning", DBCHECK, file],
    { low: true, timeoutMs: 60 * 60_000 },
  );
  if (r.code !== 0) throw new Error(`backup check of ${name} failed: ${r.err.slice(0, 300)}`);
  const check = JSON.parse(r.out);
  if (check.ic !== "ok") throw new Error(`backup integrity_check of ${name}: ${check.ic}`);
  if (expectMigration != null && check.mig !== Number(expectMigration))
    throw new Error(`backup ${name} is at migration ${check.mig}; expected ${expectMigration}`);
  const manifest = readJson(NodePath.join(destDir, "backup.json")) ?? {};
  manifest.databases = {
    ...(manifest.databases ?? {}),
    [name]: { bytes: check.bytes, sha256: check.sha256, ic: check.ic, mig: check.mig },
  };
  manifest.preCompactValidation = {
    schema: 1,
    method: "stopped-reflink-copy-integrity-check",
    database: name,
    ic: check.ic,
    mig: check.mig,
    rows: check.rows,
    mem: check.mem,
    bytes: check.bytes,
    sha256: check.sha256,
    at: new Date().toISOString(),
  };
  writeManifest(destDir, manifest);
  return { ...check, seconds: round1((Date.now() - t0) / 1000) };
}

/** Puts the verified copy of one database back, atomically, and drops the failed run's WAL and shared memory. */
export function restoreDatabase(cfg, destDir, name, { expectedSha256 } = {}) {
  const src = NodePath.join(destDir, name);
  const dst = NodePath.join(cfg.stateDir, name);
  if (!NodeFS.existsSync(src)) throw new Error(`backup copy ${src} is missing; cannot restore ${name}`);
  const tmp = NodePath.join(cfg.stateDir, `.${name}.restore-${process.pid}`);
  try {
    NodeFS.copyFileSync(src, tmp);
    const fd = NodeFS.openSync(tmp, "r+");
    try {
      NodeFS.fsyncSync(fd);
    } finally {
      NodeFS.closeSync(fd);
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) NodeFS.rmSync(dst + suffix, { force: true });
    NodeFS.renameSync(tmp, dst);
  } finally {
    NodeFS.rmSync(tmp, { force: true });
  }
  const restoreSha256 = sha256File(dst);
  const expected = expectedSha256 ?? sha256File(src);
  return {
    restored: true,
    restoreBytes: NodeFS.statSync(dst).size,
    restoreSha256,
    restoreVerified: restoreSha256 === expected,
  };
}

/** Newest-N retention, only ever called after the fresh backup verified. Only timestamp dirs with backup.json. */
export function pruneBackups(cfg, keep) {
  const all = listBackups(cfg);
  const drop = all.slice(Math.max(1, keep));
  const removed = [];
  for (const name of drop) {
    const target = NodePath.join(cfg.backups, name);
    if (NodePath.dirname(target) !== cfg.backups || NodeFS.lstatSync(target).isSymbolicLink())
      continue;
    NodeFS.rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** The guards' proof that this tool chain can back up, on a tiny fixture root on the same filesystem. */
export async function fixtureBackupProof(cfg, migration, makeFixtureDb, allowSlow) {
  const root = NodePath.join(cfg.backups, `.fixture-${process.pid}-${Date.now()}`);
  const fakeCfg = { ...cfg, stateDir: NodePath.join(root, "userdata") };
  try {
    NodeFS.mkdirSync(NodePath.join(fakeCfg.stateDir, "attachments"), { recursive: true });
    makeFixtureDb(NodePath.join(fakeCfg.stateDir, "state.sqlite"), Number(migration));
    NodeFS.writeFileSync(NodePath.join(fakeCfg.stateDir, "attachments", "a.txt"), "fixture");
    NodeFS.writeFileSync(NodePath.join(fakeCfg.stateDir, "settings.json"), "{}");
    const dest = NodePath.join(root, stamp());
    const copied = copyStopped(fakeCfg, dest, { allowSlow });
    writeManifest(dest, {
      schema: 1,
      method: "stopped-reflink-copy",
      root: "fixture",
      createdAt: new Date().toISOString(),
      files: copied,
      validation: null,
    });
    const check = await verifyBackup(cfg, dest, migration);
    if (check.rows !== 25 || check.mem !== 7)
      throw new Error(`fixture backup counts unexpected: ${JSON.stringify(check)}`);
    return check;
  } finally {
    if (root.startsWith(NodePath.join(cfg.backups, ".fixture-")))
      NodeFS.rmSync(root, { recursive: true, force: true });
  }
}
