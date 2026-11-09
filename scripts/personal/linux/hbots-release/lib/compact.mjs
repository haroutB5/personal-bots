// The opt-in database compaction step of the release runner. It runs only inside the stopped backup window,
// after the pre-restart backup copy of the target database passed its integrity check. On any failure it puts
// the verified copy back before the server starts. A compact failure never fails the release by itself.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DATABASES, restoreDatabase } from "./backup.mjs";
import { errMsg, runAsync } from "./util.mjs";

const GB = 1024 ** 3;
const gb = (bytes) => `${(Number(bytes) / GB).toFixed(2)} GB`;

/** The server opens statev2.sqlite; a pre-1.67 root still uses state.sqlite. The last one present is the live one. */
export function liveDatabaseName(cfg) {
  const present = DATABASES.filter((name) => NodeFS.existsSync(NodePath.join(cfg.stateDir, name)));
  return present.at(-1) ?? null;
}

export function compactDiskPlan(cfg, name, freeBytesOverride = 0) {
  const file = NodePath.join(cfg.stateDir, name);
  const bytes = NodeFS.statSync(file).size;
  const stat = NodeFS.statfsSync(cfg.stateDir);
  const free = Number(freeBytesOverride) > 0 ? Number(freeBytesOverride) : stat.bavail * stat.bsize;
  const needed = bytes + 2 * GB;
  return { file, bytes, free, needed, ok: free >= needed };
}

function compactCli(cfg) {
  return NodePath.join(cfg.here, "lib", "compact-db.mjs");
}

function parseOutput(text) {
  const line = String(text)
    .trim()
    .split("\n")
    .filter(Boolean)
    .at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function cleanupTemp(dir) {
  const parent = NodePath.dirname(dir);
  if (NodePath.basename(parent) !== "tmp" || !NodePath.basename(dir).startsWith("compact-")) return;
  NodeFS.rmSync(dir, { recursive: true, force: true });
  try {
    NodeFS.rmdirSync(parent);
  } catch {}
}

/**
 * Compacts the stopped live database. Returns the result object for result.compact. Throws only when the
 * restore from the verified backup fails; the caller must then keep the server stopped.
 */
export async function compactDatabase(cfg, name, opts) {
  const result = {
    database: name,
    beforeBytes: NodeFS.statSync(NodePath.join(cfg.stateDir, name)).size,
    timeoutMs: opts.timeoutMs,
  };
  const plan = compactDiskPlan(cfg, name, opts.freeBytes);
  if (!plan.ok) {
    return {
      ...result,
      skipped: true,
      reason: `not enough free disk for VACUUM: ${gb(plan.free)} free, ${gb(plan.needed)} needed (database plus 2 GB)`,
      freeBytes: plan.free,
      neededBytes: plan.needed,
    };
  }

  const tempDir = NodePath.join(cfg.home, "tmp", `compact-${process.pid}-${Date.now()}`);
  NodeFS.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  let out;
  try {
    opts.note(
      `compacting ${name}: ${gb(plan.bytes)}, time limit ${Math.round(opts.timeoutMs / 1000)} s, temp ${tempDir}`,
    );
    const r = await runAsync(
      cfg.node,
      ["--disable-warning=ExperimentalWarning", compactCli(cfg), plan.file],
      {
        timeoutMs: opts.timeoutMs,
        env: { ...process.env, SQLITE_TMPDIR: tempDir, TMPDIR: tempDir },
      },
    );
    for (const line of r.err.split("\n").map((s) => s.trim()).filter(Boolean))
      opts.note(`compact ${line}`);
    const parsed = parseOutput(r.out);
    const base = { ...result, ...(parsed ?? {}) };
    if (r.signal === "SIGKILL") {
      out = {
        ...base,
        ok: false,
        exit: 124,
        timedOut: true,
        error: `compact exceeded its ${Math.round(opts.timeoutMs / 1000)} s time limit`,
      };
    } else if (r.code !== 0 || !parsed) {
      out = {
        ...base,
        ok: false,
        exit: r.code ?? 1,
        error: parsed?.error ?? (r.err.slice(-500) || `compact exited ${r.code}`),
      };
    } else {
      out = { ...base, ok: parsed.ok === true && parsed.checkResult === "ok", exit: 0 };
      if (!out.ok) out.error = parsed.error ?? `quick_check ${parsed.checkResult ?? "missing"}`;
    }
  } catch (error) {
    out = { ...result, ok: false, exit: 1, error: errMsg(error) };
  } finally {
    cleanupTemp(tempDir);
  }

  if (out.ok) return out;

  opts.note(`compact FAILED: ${out.error}; restoring ${name} from the verified backup`);
  let restored;
  try {
    restored = restoreDatabase(cfg, opts.backupDir, name, {
      expectedSha256: opts.backupSha256,
    });
  } catch (error) {
    throw Object.assign(
      new Error(
        `compact failed (${out.error}) and the restore of ${name} failed: ${errMsg(error)}`,
      ),
      { noRollback: true },
    );
  }
  if (!restored.restoreVerified)
    throw Object.assign(
      new Error(
        `compact failed (${out.error}) and the restored ${name} does not match the verified backup`,
      ),
      { noRollback: true },
    );
  opts.note(
    `restored ${name} from ${opts.backupDir}: ${gb(restored.restoreBytes)}, sha256 ${restored.restoreSha256.slice(0, 12)} matches the verified backup`,
  );
  return { ...out, ...restored };
}
