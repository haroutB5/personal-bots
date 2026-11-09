// Backup of one data root, layout-compatible with scripts/personal/backup.ps1:
// a timestamped folder with state.sqlite and statev2.sqlite (each an online
// backup + full integrity check), their integrity proofs, the non-secret user
// files and backup.json.
// secrets/ is never copied.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { backupStamp, readJson } from "./util.mjs";

const DATABASES = ["state.sqlite", "statev2.sqlite"];
const COPY_ITEMS = [
  "attachments",
  "browser-artifacts",
  "themes",
  "settings.json",
  "keybindings.json",
  "environment-id",
];

function dirSizeBytes(dir) {
  let total = 0;
  const walk = (current) => {
    for (const entry of NodeFS.readdirSync(current, { withFileTypes: true })) {
      const full = NodePath.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += NodeFS.statSync(full).size;
    }
  };
  try {
    walk(dir);
  } catch {
    /* best effort size only */
  }
  return total;
}

function removeFreshTarget(target, backupsRoot) {
  if (!NodeFS.existsSync(target)) return;
  if (NodePath.dirname(NodePath.resolve(target)) !== NodePath.resolve(backupsRoot)) return;
  if (NodeFS.existsSync(NodePath.join(target, "backup.json"))) return;
  NodeFS.rmSync(target, { recursive: true, force: true });
}

function pruneBackups(backupsDir, keep) {
  let entries;
  try {
    entries = NodeFS.readdirSync(backupsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => NodeFS.existsSync(NodePath.join(backupsDir, name, "backup.json")))
    .sort()
    .reverse();
  const removed = [];
  for (const name of names.slice(keep)) {
    NodeFS.rmSync(NodePath.join(backupsDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function snapshotDatabase(nodeExe, snapshotScript, stateDir, target, name) {
  const snapshot = NodeChildProcess.spawnSync(
    nodeExe,
    ["--disable-warning=ExperimentalWarning", snapshotScript],
    {
      env: {
        ...process.env,
        PB_SNAPSHOT_SOURCE: NodePath.join(stateDir, name),
        PB_SNAPSHOT_TARGET: NodePath.join(target, name),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (snapshot.status !== 0) {
    throw new Error(
      `SQLite snapshot of ${name} failed (exit ${snapshot.status}): ${(snapshot.stderr || "").trim()}`,
    );
  }
  const proof = readJson(NodePath.join(target, `${name}.integrity.json`));
  if (!proof) throw new Error(`Snapshot integrity proof for ${name} is missing.`);
  return proof;
}

export function backupRoot({ paths, keep = 1, nodeExe = process.execPath, snapshotScript }) {
  const databases = DATABASES.filter((name) =>
    NodeFS.existsSync(NodePath.join(paths.stateDir, name)),
  );
  if (databases.length === 0) throw new Error(`No database in ${paths.stateDir}.`);
  if (!snapshotScript || !NodeFS.existsSync(snapshotScript))
    throw new Error(`Snapshot helper missing: ${snapshotScript}`);
  NodeFS.mkdirSync(paths.backupsDir, { recursive: true });
  const stamp = backupStamp();
  const target = NodePath.join(paths.backupsDir, stamp);
  if (NodeFS.existsSync(target)) throw new Error(`${target} already exists.`);

  const started = Date.now();
  NodeFS.mkdirSync(target, { recursive: true });
  try {
    const proofs = {};
    for (const name of databases)
      proofs[name] = snapshotDatabase(nodeExe, snapshotScript, paths.stateDir, target, name);
    const copied = [...databases];
    for (const item of COPY_ITEMS) {
      const sourcePath = NodePath.join(paths.stateDir, item);
      if (!NodeFS.existsSync(sourcePath)) continue;
      NodeFS.cpSync(sourcePath, NodePath.join(target, item), {
        recursive: true,
        force: true,
        dereference: false,
      });
      copied.push(item);
    }
    for (const entry of NodeFS.readdirSync(paths.stateDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("personal")) continue;
      NodeFS.cpSync(NodePath.join(paths.stateDir, entry.name), NodePath.join(target, entry.name), {
        recursive: true,
        force: true,
        dereference: false,
      });
      copied.push(entry.name);
    }
    const manifest = {
      root: paths.root,
      source: paths.stateDir,
      createdAt: new Date().toISOString(),
      items: copied,
      validation: proofs[databases[0]],
      databases: Object.fromEntries(
        databases.map((name) => {
          const { bytes, sha256, ic, mig } = proofs[name];
          return [name, { bytes, sha256, ic, mig }];
        }),
      ),
    };
    NodeFS.writeFileSync(
      NodePath.join(target, "backup.json.pending"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    NodeFS.renameSync(
      NodePath.join(target, "backup.json.pending"),
      NodePath.join(target, "backup.json"),
    );
    const timings = {
      snapshotAndValidationSeconds: Number(((Date.now() - started) / 1000).toFixed(3)),
      sizeMb: Number((dirSizeBytes(target) / 1024 / 1024).toFixed(1)),
    };
    NodeFS.writeFileSync(
      NodePath.join(target, "backup-timings.json"),
      `${JSON.stringify(timings, null, 2)}\n`,
    );
    const pruned = pruneBackups(paths.backupsDir, Math.max(1, keep));
    return { target, items: copied, timings, pruned };
  } catch (error) {
    removeFreshTarget(target, paths.backupsDir);
    throw error;
  }
}
