// Release folders: resolution, pruning and safe removal. A release's
// node_modules is a symlink on Linux (a junction on Windows) into the building
// checkout; removal must unlink it, never walk through it.
import fs from "node:fs";
import path from "node:path";

export function listReleases(paths) {
  try {
    return fs
      .readdirSync(paths.releasesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => name !== "current.txt");
  } catch {
    return [];
  }
}

export function activeReleaseName(paths) {
  try {
    return fs.readFileSync(paths.currentFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function resolveRelease(paths, name) {
  const release = name || activeReleaseName(paths);
  if (!release) throw new Error(`No release is active yet. Run build first (${paths.currentFile} is missing).`);
  const dir = path.join(paths.releasesDir, release);
  const bin = path.join(dir, "dist", "bin.mjs");
  if (!fs.existsSync(bin)) throw new Error(`Release '${release}' has no dist/bin.mjs (${bin}).`);
  return { name: release, dir, bin, versionFile: path.join(dir, "VERSION") };
}

export function setActiveRelease(paths, name) {
  const release = resolveRelease(paths, name);
  fs.mkdirSync(paths.releasesDir, { recursive: true });
  fs.writeFileSync(paths.currentFile, `${release.name}\n`);
  return release;
}

function mtimeOf(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

// Newest `keep` survive, plus the active release, the running release and any
// explicit protect entries (the rollback target). Mirrors Select-PbPrunableReleases.
export function selectPrunable({ paths, keep = 5, protect = [], running = null }) {
  const active = activeReleaseName(paths);
  const protectedNames = new Set([active, running, ...protect].filter(Boolean));
  const names = listReleases(paths)
    .map((name) => ({ name, mtime: mtimeOf(path.join(paths.releasesDir, name)) }))
    .sort((a, b) => b.mtime - a.mtime);
  return names.slice(keep).map((entry) => entry.name).filter((name) => !protectedNames.has(name));
}

export function removeReleaseDir(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(dir);
    return;
  }
  if (!stat.isDirectory()) {
    fs.unlinkSync(dir);
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

export function pruneReleases({ paths, keep = 5, protect = [], running = null, dryRun = true }) {
  const prunable = selectPrunable({ paths, keep, protect, running });
  for (const name of prunable) {
    const dir = path.join(paths.releasesDir, name);
    if (dryRun) {
      process.stdout.write(`would remove ${dir}\n`);
    } else {
      removeReleaseDir(dir);
      process.stdout.write(`removed ${dir}\n`);
    }
  }
  return prunable;
}

export function releaseSizeBytes(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* vanished */
        }
      }
    }
  };
  walk(dir);
  return total;
}
