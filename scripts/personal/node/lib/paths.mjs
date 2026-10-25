// Path layout shared with the PowerShell tools. Linux is the supported target;
// the same layout is used on Windows so a backup or release made by either
// toolchain is readable by the other.
import os from "node:os";
import path from "node:path";

export const ROOT_NAMES = ["dev", "prod"];

export function pbHome(env = process.env) {
  return path.resolve(env.HBOTS_HOME || path.join(os.homedir(), ".personal-bots"));
}

export function isValidRootName(root) {
  return typeof root === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(root);
}

export function getPaths({ root = "dev", home = pbHome() } = {}) {
  if (!isValidRootName(root)) throw new Error(`Invalid data root name: ${root}`);
  const base = path.resolve(home);
  const baseDir = path.join(base, root);
  const runDir = path.join(base, "run");
  const releasesDir = path.join(base, "releases");
  return {
    root,
    home: base,
    baseDir,
    stateDir: path.join(baseDir, "userdata"),
    logsDir: path.join(base, "logs"),
    runDir,
    pidFile: path.join(runDir, "server.pid"),
    stateFile: path.join(runDir, "server.json"),
    stopMarker: path.join(runDir, "stop-requested"),
    releasesDir,
    currentFile: path.join(releasesDir, "current.txt"),
    backupsDir: path.join(base, "backups"),
    workDir: path.join(base, "workspace"),
  };
}

// The default port per root is fixed: the session cookie name embeds it, so a
// different port signs every browser (the phone app included) out on restart.
export function defaultPort(root) {
  return root === "prod" ? 38473 : 38472;
}

export function repoRootFromScript(scriptUrl) {
  // scripts/personal/node/lib/paths.mjs -> repo root
  return path.resolve(path.dirname(scriptUrl), "..", "..", "..", "..");
}
