// Backup of one data root, layout-compatible with scripts/personal/backup.ps1:
// a timestamped folder with state.sqlite (online backup + full integrity
// check), its integrity proof, the non-secret user files and backup.json.
// secrets/ is never copied.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { backupStamp, readJson } from "./util.mjs";

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

export function backupRoot({ paths, keep = 1, nodeExe = process.execPath, snapshotScript }) {
  const database = NodePath.join(paths.stateDir, "state.sqlite");
  if (!NodeFS.existsSync(database)) throw new Error(`No database at ${database}.`);
  if (!snapshotScript || !NodeFS.existsSync(snapshotScript))
    throw new Error(`Snapshot helper missing: ${snapshotScript}`);
  NodeFS.mkdirSync(paths.backupsDir, { recursive: true });
  const stamp = backupStamp();
  const target = NodePath.join(paths.backupsDir, stamp);
  if (NodeFS.existsSync(target)) throw new Error(`${target} already exists.`);

  const started = Date.now();
  NodeFS.mkdirSync(target, { recursive: true });
  try {
    const snapshot = NodeChildProcess.spawnSync(
      nodeExe,
      ["--disable-warning=ExperimentalWarning", snapshotScript],
      {
        env: {
          ...process.env,
          PB_SNAPSHOT_SOURCE: database,
          PB_SNAPSHOT_TARGET: NodePath.join(target, "state.sqlite"),
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (snapshot.status !== 0) {
      throw new Error(
        `SQLite snapshot failed (exit ${snapshot.status}): ${(snapshot.stderr || "").trim()}`,
      );
    }
    const copied = ["state.sqlite"];
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
    const validation = readJson(NodePath.join(target, "state.sqlite.integrity.json"));
    if (!validation) throw new Error("Snapshot integrity proof is missing.");
    const manifest = {
      root: paths.root,
      source: paths.stateDir,
      createdAt: new Date().toISOString(),
      items: copied,
      validation,
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
