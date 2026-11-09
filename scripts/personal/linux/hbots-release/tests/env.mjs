// Builds a throwaway world for the runner: a fake HOME with releases, a fake server running in a real (but
// throwaway) systemd user unit, a temp git repo, stub dev-team tools, an app sheet, and the test overrides.
// Fixtures live under ~/.cache/hbots-release-fixture-* (btrfs, so the reflink backup path is exercised),
// with a fixture.json owner record and a reaper that removes whatever a crashed test left behind.
// Nothing here points at the live hbots data: dev/ and prod/ of the real ~/.personal-bots are never used.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import { after } from "node:test";
import { makeFixtureDb } from "../lib/fixture.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(HERE);
export const RUNNER = path.join(ROOT, "hbots-release.mjs");
export const LAUNCHER = path.join(ROOT, "hbots-release-launch.mjs");
const REAL_TOOLS = "/home/harout/Claude/AI/dev-team/tools";
const FIXTURE_PREFIX = "hbots-release-fixture-";
const UNIT_NAME = /^hbots-fixture-[A-Za-z0-9]+\.service$/;
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const cacheRoot = () =>
  process.env.HBOTS_RELEASE_FIXTURE_CACHE || path.join(os.homedir(), ".cache");
const runtimeUnitDir = () =>
  process.env.HBOTS_RELEASE_FIXTURE_RUNTIME_DIR ||
  path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "systemd", "user");
const configUnitDir = () =>
  process.env.HBOTS_RELEASE_FIXTURE_CONFIG_DIR ||
  path.join(os.homedir(), ".config", "systemd", "user");
const unitDir = () => process.env.HBOTS_RELEASE_FIXTURE_UNIT_DIR || runtimeUnitDir();
const unitDirs = () => [...new Set([unitDir(), runtimeUnitDir(), configUnitDir()])];

if (process.env.VITEST) {
  throw new Error(
    "the hbots release fixtures run under node --test, not Vitest; see scripts/personal/linux/hbots-release/README.md",
  );
}

const liveEnvs = new Set();

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const MIGRATIONS = (max) =>
  `export const migrations = [\n${Array.from({ length: max }, (_, i) => `  [${i + 1}, "m${i + 1}", Layer],`).join("\n")}\n];\n`;

function git(repo, ...args) {
  const r = sh("git", [
    "-C",
    repo,
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "user.name=fixture",
    ...args,
  ]);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// Field 22 of /proc/<pid>/stat. comm can contain spaces and parentheses, so read after the last ")".
export function procStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return (
      stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)[19] ?? null
    );
  } catch {
    return null;
  }
}

function ownerLive(record) {
  return (
    record?.schema === 1 &&
    Number.isInteger(record.ownerPid) &&
    record.ownerPid > 0 &&
    typeof record.ownerStart === "string" &&
    record.ownerStart !== "" &&
    procStart(record.ownerPid) === record.ownerStart
  );
}

function orphanReason(record) {
  if (!record) return "no record";
  if (record.schema !== 1) return `schema ${String(record.schema)}`;
  if (!Number.isInteger(record.ownerPid) || record.ownerPid <= 0) return "no owner pid";
  if (typeof record.ownerStart !== "string" || record.ownerStart === "") return "no owner start";
  const start = procStart(record.ownerPid);
  if (start === null) return `owner ${record.ownerPid} gone`;
  return `owner ${record.ownerPid} reused (${start} != ${record.ownerStart})`;
}

function readRecord(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "fixture.json"), "utf8"));
  } catch {
    return null;
  }
}

function writeRecord(dir, record) {
  const file = path.join(dir, "fixture.json");
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

function fixtureUnit(dir, record) {
  if (record && typeof record.unit === "string" && UNIT_NAME.test(record.unit)) return record.unit;
  const unit = `hbots-fixture-${path.basename(dir).split("-").pop()}.service`;
  return UNIT_NAME.test(unit) ? unit : null;
}

function isFixtureDir(dir, cacheDir) {
  const resolved = path.resolve(dir);
  return (
    path.dirname(resolved) === path.resolve(cacheDir) &&
    path.basename(resolved).startsWith(FIXTURE_PREFIX)
  );
}

function isOwnedUnitFile(file, dirs) {
  if (!UNIT_NAME.test(path.basename(file))) return false;
  const resolved = path.resolve(file);
  return dirs.some((dir) => path.resolve(dir) === path.dirname(resolved));
}

// A fixture is live only while its recorded owner PID still carries the recorded start time.
// Everything else is orphaned: dead PID, reused PID, missing record, unreadable record.
export function reapOrphans({
  dryRun = false,
  cacheDir = cacheRoot(),
  unitDirs: dirs = unitDirs(),
} = {}) {
  const result = {
    dryRun,
    cacheDir,
    scanned: 0,
    live: [],
    orphans: [],
    strayUnits: [],
    removed: [],
    failed: [],
  };
  let entries = [];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return result;
  }
  const fixtureDirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(FIXTURE_PREFIX))
    .map((e) => path.join(cacheDir, e.name));
  result.scanned = fixtureDirs.length;
  const liveUnits = new Set();
  for (const dir of fixtureDirs) {
    const record = readRecord(dir);
    if (ownerLive(record)) {
      const unit = fixtureUnit(dir, record);
      if (unit) liveUnits.add(unit);
      result.live.push({ dir, unit, ownerPid: record.ownerPid });
      continue;
    }
    result.orphans.push({ dir, unit: fixtureUnit(dir, record), reason: orphanReason(record) });
  }
  const fixtureBases = fixtureDirs.map((dir) => path.basename(dir));
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!UNIT_NAME.test(name) || liveUnits.has(name)) continue;
      const suffix = name.slice("hbots-fixture-".length, -".service".length);
      if (fixtureBases.some((base) => base.endsWith(`-${suffix}`))) continue;
      result.strayUnits.push({ unit: name, file: path.join(dir, name) });
    }
  }
  if (dryRun) return result;

  const changedUnits = new Set();
  for (const orphan of result.orphans) {
    let stopped = true;
    if (orphan.unit) {
      const stop = sh("systemctl", ["--user", "stop", orphan.unit]);
      if (stop.status !== 0 && !/not loaded|not found/i.test(stop.stderr)) {
        result.failed.push(`stop ${orphan.unit}: ${stop.stderr.trim()}`);
        stopped = false;
      } else {
        changedUnits.add(orphan.unit);
        for (const dir of dirs) {
          const file = path.join(dir, orphan.unit);
          if (!isOwnedUnitFile(file, dirs) || !fs.existsSync(file)) continue;
          fs.rmSync(file, { force: true });
          result.removed.push(file);
        }
      }
    }
    if (stopped && isFixtureDir(orphan.dir, cacheDir)) {
      try {
        fs.rmSync(orphan.dir, { recursive: true, force: true });
        result.removed.push(orphan.dir);
      } catch (e) {
        result.failed.push(`remove ${orphan.dir}: ${e.message}`);
      }
    }
  }
  for (const stray of result.strayUnits) {
    if (!isOwnedUnitFile(stray.file, dirs) || !fs.existsSync(stray.file)) continue;
    try {
      fs.rmSync(stray.file, { force: true });
      result.removed.push(stray.file);
      changedUnits.add(stray.unit);
    } catch (e) {
      result.failed.push(`remove ${stray.file}: ${e.message}`);
    }
  }
  if (changedUnits.size > 0) sh("systemctl", ["--user", "daemon-reload"]);
  return result;
}

export async function makeEnv({
  name = "t",
  baselineVersion = "9.9.0",
  targetVersion = "9.9.1",
  migrateTo = 113,
  constants = {},
} = {}) {
  reapOrphans();
  const cacheDir = cacheRoot();
  fs.mkdirSync(cacheDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(cacheDir, `${FIXTURE_PREFIX}${name}-`));
  const home = path.join(tmp, ".personal-bots"); // the runner's HOME is tmp; cfg.home = tmp/.personal-bots
  const port = await freePort();
  const unit = `hbots-fixture-${path.basename(tmp).split("-").pop()}.service`;
  for (const d of [
    "run",
    "releases",
    "logs",
    "backups",
    "flags",
    "dev/userdata/logs/provider",
    "dev/runtime",
    "tools",
    "docs",
  ])
    fs.mkdirSync(path.join(home, d), { recursive: true });
  const env = { tmp, home, port, unit, baselineVersion, targetVersion, constants };
  env.unitFile = path.join(unitDir(), unit);
  fs.mkdirSync(path.dirname(env.unitFile), { recursive: true });
  writeRecord(tmp, {
    schema: 1,
    unit,
    unitFile: env.unitFile,
    dir: tmp,
    port,
    ownerPid: process.pid,
    ownerStart: procStart(process.pid),
    createdAt: new Date().toISOString(),
  });
  liveEnvs.add(env);

  // git repo: commit 1 = rollback baseline, commit 2 = the notes commit
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "apps/server/src/persistence"), { recursive: true });
  fs.mkdirSync(path.join(repo, "apps/server/src/personal/tasks"), { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts/personal/node"), { recursive: true });
  sh("git", ["init", "-q", repo]);
  const write = (rel, text) => fs.writeFileSync(path.join(repo, rel), text);
  write(
    "apps/server/src/personal/tasks/PersonalTaskService.ts",
    "export const PERSONAL_TASKS_CONCURRENCY = 5;\n",
  );
  write("scripts/personal/node/hbots.mjs", "// placeholder\n");
  write("apps/server/src/persistence/Migrations.ts", MIGRATIONS(113));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "baseline");
  env.rollbackFull = git(repo, "rev-parse", "HEAD");
  env.rollback = env.rollbackFull.slice(0, 12);
  write("apps/server/src/persistence/Migrations.ts", MIGRATIONS(migrateTo));
  fs.mkdirSync(path.join(repo, "docs/releases"), { recursive: true });
  write("docs/releases/HANDOFF-991.md", "notes\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "notes");
  env.mainSha = git(repo, "rev-parse", "HEAD");
  env.repo = repo;
  env.release = "b".repeat(12);
  env.thread = "11111111-2222-4333-8444-555555555555";

  // stub dev-team tools (the real ones are pinned and copied so PINS.json covers the same set of names)
  const tools = path.join(tmp, "tools");
  fs.mkdirSync(tools, { recursive: true });
  for (const f of [
    "check-release-notes.mjs",
    "check-gate-evidence.mjs",
    "gate-common.mjs",
    "ops-common.mjs",
    "notify-release.mjs",
  ])
    fs.copyFileSync(path.join(REAL_TOOLS, f), path.join(tools, f));
  const flags = path.join(home, "flags");
  const stub = (file, body) =>
    fs.writeFileSync(path.join(tools, file), `import fs from "node:fs";\n${body}\n`);
  stub(
    "check-release-notes.mjs",
    `if (fs.existsSync(${JSON.stringify(path.join(flags, "notes-fail"))})) { console.error("notes missing"); process.exit(1); }\nconsole.log("PASS: stub notes check");`,
  );
  stub(
    "check-gate-evidence.mjs",
    `if (fs.existsSync(${JSON.stringify(path.join(flags, "evidence-fail"))})) { console.error("evidence failed"); process.exit(1); }\nconsole.log("PASS: stub evidence check");`,
  );
  stub(
    "notify-release.mjs",
    `fs.appendFileSync(${JSON.stringify(path.join(tmp, "notices.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");\nconsole.log("notice recorded");`,
  );
  env.tools = tools;

  // app sheet + history
  env.sheet = path.join(tmp, "app.md");
  env.history = path.join(tmp, "history.md");
  fs.writeFileSync(
    env.sheet,
    `# App\n\n- Live: **v${baselineVersion}** live since 2026-10-01 10:00:00 BST (release ${env.rollback}). Release logs and old live lines: \`apps/personal-bots-history.md\`.\n`,
  );
  fs.writeFileSync(env.history, "# History\n\n## 1. Old live line (was line 3)\n\n");

  // releases: baseline (live) and target
  env.makeRelease = (sha, version, { migrates = false, badLog = false } = {}) =>
    makeRelease(env, sha, version, { migrates, badLog });
  makeRelease(env, env.rollback, baselineVersion, {});
  fs.writeFileSync(path.join(home, "releases", "current.txt"), `${env.rollback}\n`);
  if (migrateTo > 113) {
    makeFixtureDb(path.join(home, "dev", "userdata", "state.sqlite"), 113);
    fs.mkdirSync(path.join(home, "dev", "userdata", "secrets"), { recursive: true });
    fs.mkdirSync(path.join(home, "dev", "userdata", "attachments"), { recursive: true });
    fs.writeFileSync(path.join(home, "dev", "userdata", "attachments", "a.txt"), "x");
  }
  env.target = (opts = {}) =>
    makeRelease(env, env.release, targetVersion, { migrates: migrateTo > 113, ...opts });
  env.overrides = overrides(env);
  env.args = (extra = []) => [
    "--release",
    env.release,
    "--rollback",
    env.rollback,
    "--main-sha",
    env.mainSha,
    "--version",
    targetVersion,
    "--notify-thread",
    env.thread,
    "--migration-before",
    "113",
    "--migration-after",
    String(migrateTo),
    "--repo-root",
    repo,
    "--app-sheet",
    env.sheet,
    "--app-history",
    env.history,
    "--stable-seconds",
    "2",
    ...extra,
  ];
  env.node = process.execPath;
  env.processEnv = () => ({ ...process.env, HOME: tmp, ...env.overrides });
  env.runner = (mode, extra = [], opts = {}) =>
    sh(env.node, [RUNNER, ...(mode ? [mode] : []), ...env.args(extra)], {
      env: env.processEnv(),
      timeout: 600_000,
      ...opts,
    });
  env.launch = (mode, extra = [], opts = {}) =>
    sh(env.node, [LAUNCHER, ...(mode ? [mode] : []), ...env.args(extra)], {
      env: env.processEnv(),
      timeout: 600_000,
      ...opts,
    });
  env.result = (mode = "") =>
    JSON.parse(
      fs.readFileSync(
        path.join(
          home,
          "run",
          `restart-${targetVersion}${{ "": "", "--dry-run": "-dryrun", "--prepare": "-prepare", "--guards-only": "-guards" }[mode]}-result.json`,
        ),
        "utf8",
      ),
    );
  env.flag = (n) => fs.writeFileSync(path.join(flags, n), "1");
  env.notices = () =>
    fs.existsSync(path.join(tmp, "notices.jsonl"))
      ? fs
          .readFileSync(path.join(tmp, "notices.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  env.serverJson = () => JSON.parse(fs.readFileSync(path.join(home, "run", "server.json"), "utf8"));
  env.start = (opts) => startUnit(env, opts);
  env.stop = () => cleanup(env);
  env.writePins = () => sh(env.node, [RUNNER, "--write-pins"], { env: env.processEnv() });
  return env;
}

function overrides(env) {
  const c = {
    LOOK_MS: 700,
    QUIET_LOOKS: 2,
    EVENTS_QUIET_MS: 1500,
    CPU_BUDGET_S: 5,
    MARATHON_MS: 90_000,
    START_TIMEOUT_MS: 40_000,
    ...env.constants,
  };
  const o = {
    HBOTS_RELEASE_TEST: "1",
    HBOTS_RELEASE_TEST_HOME: env.home,
    HBOTS_RELEASE_TEST_NODE: process.execPath,
    HBOTS_RELEASE_TEST_UNIT: env.unit,
    HBOTS_RELEASE_TEST_LOCK: path.join(env.tmp, "heavy.lock"),
    HBOTS_RELEASE_TEST_TOOLS: env.tools,
    HBOTS_RELEASE_TEST_CLI: path.join(HERE, "fake", "cli.mjs"),
    HBOTS_RELEASE_TEST_PORT: String(env.port),
    HBOTS_RELEASE_TEST_PINS: path.join(env.tmp, "PINS.json"),
    FIXTURE_HOME: env.home,
    FIXTURE_PORT: String(env.port),
  };
  for (const [k, v] of Object.entries(c)) o[`HBOTS_RELEASE_TEST_${k}`] = String(v);
  return o;
}

function makeRelease(env, sha, version, { migrates, badLog }) {
  const dir = path.join(env.home, "releases", sha);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "fixture-pkg"), { recursive: true });
  const bin = path.join(dir, "dist", "bin.mjs");
  fs.writeFileSync(
    bin,
    `${fs.readFileSync(path.join(HERE, "fake", "server.mjs"), "utf8")}\n// build ${sha} ${version}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "node_modules", "fixture-pkg", "index.js"),
    `module.exports = ${JSON.stringify(sha)};\n`,
  );
  fs.writeFileSync(
    path.join(dir, "VERSION"),
    `version=${version}\nrelease=${sha}\ndirty=false\nexternals=copied\n`,
  );
  if (migrates) fs.writeFileSync(path.join(dir, "MIGRATES"), "");
  if (badLog) fs.writeFileSync(path.join(dir, "BAD_LOG"), "");
  // evidence is written last: its startedAt must be newer than every artifact file
  const startedAt = new Date(Date.now() + 1000).toISOString();
  fs.writeFileSync(
    path.join(dir, "gate-evidence.json"),
    JSON.stringify({
      sha: env.mainSha ?? "0".repeat(40),
      startedAt,
      finishedAt: startedAt,
      release: sha,
      binSha256: sha256(fs.readFileSync(bin)),
      gates: [{ id: "e2e", counts: { journeys: 3, passed: 3 } }],
    }),
  );
  return dir;
}

export function startUnit(env, { child } = {}) {
  const unitFile = env.unitFile ?? path.join(unitDir(), env.unit);
  env.unitFile = unitFile;
  const exec = `/bin/sh -c 'exec ${process.execPath} "${env.home}/releases/$$(cat ${env.home}/releases/current.txt)/dist/bin.mjs" serve'`;
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.writeFileSync(
    unitFile,
    `[Unit]\nDescription=hbots release runner fixture server (throwaway)\n\n[Service]\nType=simple\nEnvironment=FIXTURE_HOME=${env.home}\nEnvironment=FIXTURE_PORT=${env.port}\n${child === undefined ? "" : `Environment="FIXTURE_CHILD=${child}"\n`}ExecStart=${exec}\nKillMode=control-group\nRuntimeMaxSec=900\nMemoryAccounting=yes\n`,
  );
  sh("systemctl", ["--user", "daemon-reload"]);
  const r = sh("systemctl", ["--user", "start", env.unit]);
  if (r.status !== 0) throw new Error(`could not start ${env.unit}: ${r.stderr}`);
}

export function cleanup(env) {
  if (!env) return;
  if (env.unit) sh("systemctl", ["--user", "stop", env.unit]);
  for (const u of sh("systemctl", [
    "--user",
    "list-units",
    "--all",
    "--plain",
    "--no-legend",
    "hbots-release-*",
  ]).stdout.split("\n")) {
    const n = u.trim().split(/\s+/)[0];
    if (n && n.includes(env.targetVersion)) sh("systemctl", ["--user", "stop", n]);
  }
  if (env.unit) {
    const dirs = unitDirs();
    for (const dir of dirs) {
      const file = path.join(dir, env.unit);
      if (isOwnedUnitFile(file, dirs) && fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    if (fs.existsSync(env.unitFile ?? "")) fs.rmSync(env.unitFile, { force: true });
    sh("systemctl", ["--user", "daemon-reload"]);
  }
  if (env.tmp && isFixtureDir(env.tmp, cacheRoot()))
    fs.rmSync(env.tmp, { recursive: true, force: true });
  liveEnvs.delete(env);
}

export function cleanupAll() {
  for (const env of [...liveEnvs]) cleanup(env);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isCli) {
  after(cleanupAll);
  process.once("exit", cleanupAll);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      cleanupAll();
      process.exit(128 + (os.constants.signals[signal] ?? 0));
    });
  }
}

if (isCli) {
  const dryRun = process.argv.includes("--dry-run");
  const result = reapOrphans({ dryRun });
  for (const orphan of result.orphans)
    console.log(
      `${dryRun ? "would remove" : "remove"} ${orphan.dir} unit=${orphan.unit ?? "-"} reason=${orphan.reason}`,
    );
  for (const stray of result.strayUnits)
    console.log(`${dryRun ? "would remove" : "remove"} stray unit ${stray.file}`);
  for (const failure of result.failed) console.error(`failed: ${failure}`);
  console.log(
    `${result.scanned} fixture dirs, ${result.live.length} live, ${result.orphans.length} orphaned, ` +
      `${result.strayUnits.length} stray units, ${result.removed.length} removed${dryRun ? " (dry run)" : ""}`,
  );
  process.exitCode = result.failed.length > 0 ? 1 : 0;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sh, spawn };
