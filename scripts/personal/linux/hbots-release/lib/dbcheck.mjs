// Checks a COPY of the database (a backup). It refuses every path under the live data roots: opening the live
// state.sqlite or its -wal/-shm from a second process crashed the server with SIGBUS on 26 Oct.
// Library: checkCopy(file). CLI: node dbcheck.mjs <backup-dir>/state.sqlite
//   -> checkpoints the copy into a single file, runs integrity_check, prints {"ic","rows","mem","mig","bytes","sha256"}.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const LIVE_ROOTS = [/^\/home\/[^/]+\/\.personal-bots\/(dev|prod)(\/|$)/];

export function assertNotLive(file) {
  const real = fs.realpathSync(file);
  if (LIVE_ROOTS.some((re) => re.test(real)) || /(^|\/)userdata\/state\.sqlite$/.test(real)) {
    throw new Error(`refusing to open ${real}: it is under a live data root`);
  }
  if (path.basename(real) !== "state.sqlite") throw new Error("expected a file named state.sqlite inside a backup directory");
  if (!fs.existsSync(path.join(path.dirname(real), "backup.json"))) throw new Error("the directory has no backup.json: not a backup copy");
  return real;
}

function digest(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(8 << 20);
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function checkCopy(file, { withDigest = true } = {}) {
  const real = assertNotLive(file);
  const db = new DatabaseSync(real);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA journal_mode = DELETE"); // a standalone file: no -wal/-shm next to the backup
    db.exec("PRAGMA cache_size = -65536; PRAGMA mmap_size = 0");
    const verdicts = db.prepare("PRAGMA integrity_check").all();
    if (verdicts.length !== 1 || Object.values(verdicts[0])[0] !== "ok") throw new Error(`integrity_check failed: ${JSON.stringify(verdicts).slice(0, 300)}`);
    const count = (sql) => {
      try {
        return Number(db.prepare(sql).get().n);
      } catch {
        return null;
      }
    };
    const out = {
      ic: "ok",
      rows: count("SELECT count(*) n FROM projection_thread_activities"),
      mem: count("SELECT count(*) n FROM personal_memory"),
      mig: count("SELECT max(migration_id) n FROM effect_sql_migrations"),
    };
    db.close();
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(real + suffix, { force: true });
    out.bytes = fs.statSync(real).size;
    if (withDigest) out.sha256 = digest(real);
    return out;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    console.log(JSON.stringify(checkCopy(process.argv[2])));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
