import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function writeText(file, text) {
  fs.writeFileSync(file, text);
}

export function ensureDirs(dirs) {
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
}

export function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

// Runs a command and returns { code, stdout, stderr }. Never throws on a
// non-zero exit: callers decide. stdio is captured unless `inherit` is set.
export function run(command, args, { cwd, env, inherit = false, timeout = 0 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ?? process.env,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: timeout || undefined,
    shell: false,
  });
  if (result.error && result.error.code !== "ETIMEDOUT") {
    return { code: -1, stdout: result.stdout ?? "", stderr: String(result.error.message) };
  }
  return {
    code: result.status ?? (result.error ? 124 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function git(repoRoot, args) {
  const result = run("git", args, { cwd: repoRoot });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function log(line = "") {
  process.stdout.write(`${line}\n`);
}

export function warn(line) {
  process.stderr.write(`${line}\n`);
}

// 12-char sha, the release folder name used by every existing tool.
export function shortSha(repoRoot) {
  return git(repoRoot, ["rev-parse", "--short=12", "HEAD"]);
}

export function utcStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// PowerShell used yyyyMMdd-HHmmss for backup folders; keep that exact shape so
// retention on either platform recognises the other's backups.
export function backupStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function loadRepoEnv(repoRoot) {
  const file = path.join(repoRoot, ".env");
  const text = readText(file);
  return { file, values: text ? parseDotEnv(text) : {} };
}
