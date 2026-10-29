// Backup for big releases (a migration change or --force-backup), built for a database that must never be
// opened by a second process while the server runs. The server is STOPPED, the files are reflink-copied
// (btrfs: copy-on-write, a few seconds for 6 GB), the server is started again on the new release, and the copy is
// then checkpointed and integrity-checked at background priority while the new release is already up.
// Nothing here ever opens the live state.sqlite or its -wal/-shm; sizes come from stat only.
import fs from "node:fs";
import path from "node:path";
import { run, runAsync, readJson, atomicWrite, round1 } from "./util.mjs";
import { fileURLToPath } from "node:url";

const DBCHECK = path.join(path.dirname(fileURLToPath(import.meta.url)), "dbcheck.mjs");
export const BACKUP_NAME = /^\d{8}-\d{6}$/;

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Sizes by stat only (no open). */
export function liveSizes(cfg) {
  const size = (f) => {
    try {
      return fs.statSync(path.join(cfg.stateDir, f)).size;
    } catch {
      return 0;
    }
  };
  return { db: size("state.sqlite"), wal: size("state.sqlite-wal"), shm: size("state.sqlite-shm") };
}

export function listBackups(cfg) {
  try {
    return fs
      .readdirSync(cfg.backups, { withFileTypes: true })
      .filter((d) => d.isDirectory() && BACKUP_NAME.test(d.name) && fs.existsSync(path.join(cfg.backups, d.name, "backup.json")))
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Reflink needs the same filesystem and a filesystem that supports it. Probed in the backups dir only. */
export function reflinkProbe(cfg) {
  fs.mkdirSync(cfg.backups, { recursive: true });
  const same = fs.statSync(cfg.backups).dev === fs.statSync(cfg.stateDir).dev;
  if (!same) return { ok: false, reason: "backups and the data folder are on different filesystems" };
  const probe = path.join(cfg.backups, `.reflink-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, Buffer.alloc(8192, 7));
    const r = run("cp", ["--reflink=always", probe, `${probe}.copy`], { timeout: 15_000 });
    return r.code === 0 ? { ok: true } : { ok: false, reason: r.err.slice(0, 160) || "cp --reflink=always failed" };
  } finally {
    fs.rmSync(probe, { force: true });
    fs.rmSync(`${probe}.copy`, { force: true });
  }
}

export function diskPlan(cfg, reflinkOk, allowSlow) {
  const sizes = liveSizes(cfg);
  const st = fs.statfsSync(cfg.backups);
  const free = st.bavail * st.bsize;
  const need = Math.max(2 * 1024 ** 3, 2 * sizes.wal + (reflinkOk ? 0.05 * sizes.db : 1.2 * sizes.db));
  return { free, need, ok: free >= need && (reflinkOk || allowSlow), sizes };
}

/** Copies the (stopped) data files into destDir. Returns what was copied. */
export function copyStopped(cfg, destDir, { allowSlow = false } = {}) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const mode = allowSlow ? "--reflink=auto" : "--reflink=always";
  const copied = [];
  for (const name of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm", "settings.json"]) {
    const src = path.join(cfg.stateDir, name);
    if (!fs.existsSync(src)) {
      if (name === "state.sqlite") throw new Error(`no ${src} to back up`);
      continue;
    }
    const r = run("cp", [mode, "--preserve=timestamps", src, path.join(destDir, name)], { timeout: 600_000 });
    if (r.code !== 0) throw new Error(`copy of ${name} failed: ${r.err.slice(0, 200)}`);
    const a = fs.statSync(src).size;
    const b = fs.statSync(path.join(destDir, name)).size;
    if (a !== b) throw new Error(`copy of ${name} has ${b} bytes, the source ${a}`);
    copied.push({ name, bytes: b });
  }
  for (const dir of ["secrets", "attachments"]) {
    const src = path.join(cfg.stateDir, dir);
    if (!fs.existsSync(src)) continue;
    const r = run("cp", ["-a", mode, src, path.join(destDir, dir)], { timeout: 600_000 });
    if (r.code !== 0) throw new Error(`copy of ${dir}/ failed: ${r.err.slice(0, 200)}`);
    copied.push({ name: `${dir}/` });
  }
  const head = Buffer.alloc(16);
  const fd = fs.openSync(path.join(destDir, "state.sqlite"), "r");
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString("latin1") !== "SQLite format 3\0") throw new Error("the copied state.sqlite does not start with the SQLite header");
  return copied;
}

export function writeManifest(destDir, manifest) {
  atomicWrite(path.join(destDir, "backup.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Checkpoint + integrity_check + digest on the COPY, at idle I/O priority. Updates the manifest. */
export async function verifyBackup(cfg, destDir, expectMigration) {
  const t0 = Date.now();
  const r = await runAsync(cfg.node, ["--disable-warning=ExperimentalWarning", DBCHECK, path.join(destDir, "state.sqlite")], { low: true, timeoutMs: 60 * 60_000 });
  if (r.code !== 0) throw new Error(`backup check failed: ${r.err.slice(0, 300)}`);
  const check = JSON.parse(r.out);
  if (check.ic !== "ok") throw new Error(`backup integrity_check: ${check.ic}`);
  if (expectMigration != null && check.mig !== Number(expectMigration)) throw new Error(`backup is at migration ${check.mig}; expected ${expectMigration}`);
  const manifest = readJson(path.join(destDir, "backup.json")) ?? {};
  manifest.validation = { schema: 1, method: "stopped-reflink-copy-integrity-check", ic: check.ic, mig: check.mig, rows: check.rows, mem: check.mem, bytes: check.bytes, sha256: check.sha256 };
  writeManifest(destDir, manifest);
  return { ...check, seconds: round1((Date.now() - t0) / 1000) };
}

/** Newest-N retention, only ever called after the fresh backup verified. Only timestamp dirs with backup.json. */
export function pruneBackups(cfg, keep) {
  const all = listBackups(cfg);
  const drop = all.slice(Math.max(1, keep));
  const removed = [];
  for (const name of drop) {
    const target = path.join(cfg.backups, name);
    if (path.dirname(target) !== cfg.backups || fs.lstatSync(target).isSymbolicLink()) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** The guards' proof that this tool chain can back up, on a tiny fixture root on the same filesystem. */
export async function fixtureBackupProof(cfg, migration, makeFixtureDb, allowSlow) {
  const root = path.join(cfg.backups, `.fixture-${process.pid}-${Date.now()}`);
  const fakeCfg = { ...cfg, stateDir: path.join(root, "userdata") };
  try {
    fs.mkdirSync(path.join(fakeCfg.stateDir, "attachments"), { recursive: true });
    makeFixtureDb(path.join(fakeCfg.stateDir, "state.sqlite"), Number(migration));
    fs.writeFileSync(path.join(fakeCfg.stateDir, "attachments", "a.txt"), "fixture");
    fs.writeFileSync(path.join(fakeCfg.stateDir, "settings.json"), "{}");
    const dest = path.join(root, stamp());
    const copied = copyStopped(fakeCfg, dest, { allowSlow });
    writeManifest(dest, { schema: 1, method: "stopped-reflink-copy", root: "fixture", createdAt: new Date().toISOString(), files: copied, validation: null });
    const check = await verifyBackup(cfg, dest, migration);
    if (check.rows !== 25 || check.mem !== 7) throw new Error(`fixture backup counts unexpected: ${JSON.stringify(check)}`);
    return check;
  } finally {
    if (root.startsWith(path.join(cfg.backups, ".fixture-"))) fs.rmSync(root, { recursive: true, force: true });
  }
}
