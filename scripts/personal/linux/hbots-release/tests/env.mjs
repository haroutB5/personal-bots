// Builds a throwaway world for the runner: a fake HOME with releases, a fake server running in a real (but
// throwaway) systemd user unit, a temp git repo, stub dev-team tools, an app sheet, and the test overrides.
// Fixtures live under ~/.cache/hbots-release-fixture-* (btrfs, so the reflink backup path is exercised),
// with a fixture.json owner record and a reaper that removes whatever a crashed test left behind.
// Nothing here points at the live hbots data: dev/ and prod/ of the real ~/.personal-bots are never used.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeTest from "node:test";
import { makeFixtureDb } from "../lib/fixture.mjs";
import { planChecks } from "../lib/gateScope.mjs";
import { gitReader } from "../lib/serverTestSelect.mjs";

export const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const ROOT = NodePath.dirname(HERE);
export const RUNNER = NodePath.join(ROOT, "hbots-release.mjs");
export const LAUNCHER = NodePath.join(ROOT, "hbots-release-launch.mjs");
const REAL_TOOLS = "/home/harout/Claude/AI/dev-team/tools";
const FIXTURE_PREFIX = "hbots-release-fixture-";
const STAGING_PREFIX = `.${FIXTURE_PREFIX}staging-`;
const UNIT_PREFIX = "hbots-fixture-";
const UNIT_NAME = /^hbots-fixture-(?:[a-f0-9]{8}-)?[A-Za-z0-9]+\.service$/;
const SAFE_SUFFIX = /^[A-Za-z0-9]+$/;
const sh = (cmd, args, opts = {}) =>
  NodeChildProcess.spawnSync(cmd, args, { encoding: "utf8", ...opts });
const sha256 = (buf) => NodeCrypto.createHash("sha256").update(buf).digest("hex");

// A fixture unit carries a short hash of its cache dir, so two caches can share the runtime unit
// dir and each reaper only treats unit files with its own tag as its strays.
function cacheTag(cacheDir) {
  return NodeCrypto.createHash("sha256")
    .update(NodePath.resolve(cacheDir))
    .digest("hex")
    .slice(0, 8);
}

export const cacheRoot = () =>
  process.env.HBOTS_RELEASE_FIXTURE_CACHE || NodePath.join(NodeOS.homedir(), ".cache");
export const runtimeUnitDir = () =>
  process.env.HBOTS_RELEASE_FIXTURE_RUNTIME_DIR ||
  NodePath.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "systemd", "user");
export const configUnitDir = () =>
  process.env.HBOTS_RELEASE_FIXTURE_CONFIG_DIR ||
  NodePath.join(NodeOS.homedir(), ".config", "systemd", "user");
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
    const s = NodeNet.createServer().listen(0, "127.0.0.1", () => {
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
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
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
    return JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "fixture.json"), "utf8"));
  } catch {
    return null;
  }
}

function writeRecord(dir, record) {
  const file = NodePath.join(dir, "fixture.json");
  NodeFS.writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  NodeFS.renameSync(`${file}.tmp`, file);
}

const unitSuffix = (unit) => unit.slice(UNIT_PREFIX.length, -".service".length);

// A record names the fixture's unit only when that name carries this dir's suffix and either this
// cache's tag or none (a fixture written before the tag existed). A record-less old leak offers
// both names so its pre-tag unit file still converges.
function fixtureUnits(dir, record, cacheDir) {
  const suffix = NodePath.basename(dir).split("-").pop();
  const tag = cacheTag(cacheDir);
  const recorded = record?.unit;
  if (
    typeof recorded === "string" &&
    UNIT_NAME.test(recorded) &&
    (unitSuffix(recorded) === suffix || unitSuffix(recorded) === `${tag}-${suffix}`)
  )
    return [recorded];
  if (!SAFE_SUFFIX.test(suffix)) return [];
  return [`${UNIT_PREFIX}${tag}-${suffix}.service`, `${UNIT_PREFIX}${suffix}.service`];
}

function isFixtureDir(dir, cacheDir) {
  const resolved = NodePath.resolve(dir);
  return (
    NodePath.dirname(resolved) === NodePath.resolve(cacheDir) &&
    NodePath.basename(resolved).startsWith(FIXTURE_PREFIX)
  );
}

function isOwnedUnitFile(file, dirs) {
  if (!UNIT_NAME.test(NodePath.basename(file))) return false;
  const resolved = NodePath.resolve(file);
  return dirs.some((dir) => NodePath.resolve(dir) === NodePath.dirname(resolved));
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
    entries = NodeFS.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return result;
  }
  const fixtureDirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(FIXTURE_PREFIX))
    .map((e) => NodePath.join(cacheDir, e.name));
  result.scanned = fixtureDirs.length;
  const liveUnits = new Set();
  const ownUnitPrefix = `${UNIT_PREFIX}${cacheTag(cacheDir)}-`;
  for (const dir of fixtureDirs) {
    const record = readRecord(dir);
    if (!record && !NodeFS.existsSync(dir)) continue; // removed by its owner while we looked
    if (ownerLive(record)) {
      const units = fixtureUnits(dir, record, cacheDir);
      for (const unit of units) liveUnits.add(unit);
      result.live.push({ dir, unit: units[0] ?? null, ownerPid: record.ownerPid });
      continue;
    }
    const units = fixtureUnits(dir, record, cacheDir);
    result.orphans.push({ dir, unit: units[0] ?? null, units, reason: orphanReason(record) });
  }
  const fixtureBases = fixtureDirs.map((dir) => NodePath.basename(dir));
  for (const dir of dirs) {
    let names = [];
    try {
      names = NodeFS.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!UNIT_NAME.test(name) || liveUnits.has(name)) continue;
      if (!name.startsWith(ownUnitPrefix)) continue;
      const suffix = name.slice(ownUnitPrefix.length, -".service".length);
      if (fixtureBases.some((base) => base.endsWith(`-${suffix}`))) continue;
      result.strayUnits.push({ unit: name, file: NodePath.join(dir, name) });
    }
  }
  if (dryRun) return result;

  const changedUnits = new Set();
  for (const orphan of result.orphans) {
    let stopped = true;
    for (const unit of orphan.units) {
      const stop = sh("systemctl", ["--user", "stop", unit]);
      if (stop.status !== 0 && !/not loaded|not found/i.test(stop.stderr)) {
        result.failed.push(`stop ${unit}: ${stop.stderr.trim()}`);
        stopped = false;
        continue;
      }
      changedUnits.add(unit);
      for (const dir of dirs) {
        const file = NodePath.join(dir, unit);
        if (!isOwnedUnitFile(file, dirs) || !NodeFS.existsSync(file)) continue;
        NodeFS.rmSync(file, { force: true });
        result.removed.push(file);
      }
    }
    if (stopped && isFixtureDir(orphan.dir, cacheDir)) {
      try {
        if (removeFixtureDir(orphan.dir)) result.removed.push(orphan.dir);
      } catch (e) {
        result.failed.push(`remove ${orphan.dir}: ${e.message}`);
      }
    }
  }
  for (const stray of result.strayUnits) {
    if (!isOwnedUnitFile(stray.file, dirs) || !NodeFS.existsSync(stray.file)) continue;
    try {
      NodeFS.rmSync(stray.file, { force: true });
      result.removed.push(stray.file);
      changedUnits.add(stray.unit);
    } catch (e) {
      result.failed.push(`remove ${stray.file}: ${e.message}`);
    }
  }
  if (changedUnits.size > 0) sh("systemctl", ["--user", "daemon-reload"]);
  return result;
}

// A fixture is built under a hidden staging name the reaper ignores, gets its record there, and is
// renamed into place. The final dir is therefore never visible to a concurrent reaper without a record.
function stagingFixture(cacheDir, name) {
  for (;;) {
    const staging = NodeFS.mkdtempSync(NodePath.join(cacheDir, STAGING_PREFIX));
    const suffix = NodePath.basename(staging).slice(STAGING_PREFIX.length);
    const dir = NodePath.join(cacheDir, `${FIXTURE_PREFIX}${name}-${suffix}`);
    if (!NodeFS.existsSync(dir)) return { staging, dir, suffix };
    NodeFS.rmSync(staging, { recursive: true, force: true });
  }
}

// A fixture leaves the scanned namespace by rename, never by deleting its record in place, so a
// concurrent reaper sees either a live fixture or no fixture at that NodePath.
function removeFixtureDir(dir) {
  const trash = NodePath.join(
    NodePath.dirname(dir),
    `${STAGING_PREFIX}deleted-${NodePath.basename(dir)}-${NodeCrypto.randomBytes(3).toString("hex")}`,
  );
  try {
    NodeFS.renameSync(dir, trash);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  NodeFS.rmSync(trash, { recursive: true, force: true });
  return true;
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
  NodeFS.mkdirSync(cacheDir, { recursive: true });
  const port = await freePort();
  const { staging, dir: tmp, suffix } = stagingFixture(cacheDir, name);
  const home = NodePath.join(tmp, ".personal-bots"); // the runner's HOME is tmp; cfg.home = tmp/.personal-bots
  const build = NodePath.join(staging, ".personal-bots");
  const unit = `${UNIT_PREFIX}${cacheTag(cacheDir)}-${suffix}.service`;
  const env = { tmp, home, port, unit, baselineVersion, targetVersion, constants };
  try {
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
      NodeFS.mkdirSync(NodePath.join(build, d), { recursive: true });
    env.unitFile = NodePath.join(unitDir(), unit);
    NodeFS.mkdirSync(NodePath.dirname(env.unitFile), { recursive: true });
    writeRecord(staging, {
      schema: 1,
      unit,
      unitFile: env.unitFile,
      dir: tmp,
      port,
      ownerPid: process.pid,
      ownerStart: procStart(process.pid),
      createdAt: new Date().toISOString(),
    });
    NodeFS.renameSync(staging, tmp);
  } catch (e) {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  liveEnvs.add(env);

  // git repo: commit 1 = rollback baseline, commit 2 = the notes commit
  const repo = NodePath.join(tmp, "repo");
  NodeFS.mkdirSync(NodePath.join(repo, "apps/server/src/persistence"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(repo, "apps/server/src/personal/tasks"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(repo, "scripts/personal/node"), { recursive: true });
  sh("git", ["init", "-q", repo]);
  const write = (rel, text) => NodeFS.writeFileSync(NodePath.join(repo, rel), text);
  write(
    "apps/server/src/personal/tasks/PersonalTaskService.ts",
    "export const PERSONAL_TASKS_CONCURRENCY = 7;\n",
  );
  write("scripts/personal/node/hbots.mjs", "// placeholder\n");
  write("apps/server/src/persistence/Migrations.ts", MIGRATIONS(113));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "baseline");
  env.rollbackFull = git(repo, "rev-parse", "HEAD");
  env.rollback = env.rollbackFull.slice(0, 12);
  write("apps/server/src/persistence/Migrations.ts", MIGRATIONS(migrateTo));
  NodeFS.mkdirSync(NodePath.join(repo, "docs/releases"), { recursive: true });
  write("docs/releases/HANDOFF-991.md", "notes\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "notes");
  env.mainSha = git(repo, "rev-parse", "HEAD");
  env.repo = repo;
  // The release is a real commit of the fixture repo: the seal recomputes the gate plan from it.
  env.release = env.mainSha.slice(0, 12);
  env.thread = "11111111-2222-4333-8444-555555555555";

  // stub dev-team tools (the real ones are pinned and copied so PINS.json covers the same set of names)
  const tools = NodePath.join(tmp, "tools");
  NodeFS.mkdirSync(tools, { recursive: true });
  for (const f of [
    "check-release-notes.mjs",
    "check-gate-evidence.mjs",
    "gate-common.mjs",
    "ops-common.mjs",
    "notify-release.mjs",
  ])
    NodeFS.copyFileSync(NodePath.join(REAL_TOOLS, f), NodePath.join(tools, f));
  const flags = NodePath.join(home, "flags");
  const stub = (file, body) =>
    NodeFS.writeFileSync(
      NodePath.join(tools, file),
      `import * as NodeFS from "node:fs";\n${body}\n`,
    );
  stub(
    "check-release-notes.mjs",
    `if (NodeFS.existsSync(${JSON.stringify(NodePath.join(flags, "notes-fail"))})) { console.error("notes missing"); process.exit(1); }\nconsole.log("PASS: stub notes check");`,
  );
  stub(
    "check-gate-evidence.mjs",
    `if (NodeFS.existsSync(${JSON.stringify(NodePath.join(flags, "evidence-fail"))})) { console.error("evidence failed"); process.exit(1); }\nconsole.log("PASS: stub evidence check");`,
  );
  stub(
    "notify-release.mjs",
    `NodeFS.appendFileSync(${JSON.stringify(NodePath.join(tmp, "notices.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");\nconsole.log("notice recorded");`,
  );
  env.tools = tools;

  // app sheet + history
  env.sheet = NodePath.join(tmp, "app.md");
  env.history = NodePath.join(tmp, "history.md");
  NodeFS.writeFileSync(
    env.sheet,
    `# App\n\n- Live: **v${baselineVersion}** live since 2026-10-01 10:00:00 BST (release ${env.rollback}). Release logs and old live lines: \`apps/personal-bots-history.md\`.\n`,
  );
  NodeFS.writeFileSync(env.history, "# History\n\n## 1. Old live line (was line 3)\n\n");

  // releases: baseline (live) and target
  env.makeRelease = (sha, version, { migrates = false, badLog = false } = {}) =>
    makeRelease(env, sha, version, { migrates, badLog });
  makeRelease(env, env.rollback, baselineVersion, {});
  NodeFS.writeFileSync(NodePath.join(home, "releases", "current.txt"), `${env.rollback}\n`);
  if (migrateTo > 113) {
    makeFixtureDb(NodePath.join(home, "dev", "userdata", "state.sqlite"), 113);
    NodeFS.mkdirSync(NodePath.join(home, "dev", "userdata", "secrets"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(home, "dev", "userdata", "attachments"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(home, "dev", "userdata", "attachments", "a.txt"), "x");
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
      NodeFS.readFileSync(
        NodePath.join(
          home,
          "run",
          `restart-${targetVersion}${{ "": "", "--dry-run": "-dryrun", "--prepare": "-prepare", "--guards-only": "-guards" }[mode]}-result.json`,
        ),
        "utf8",
      ),
    );
  env.flag = (n) => NodeFS.writeFileSync(NodePath.join(flags, n), "1");
  env.notices = () =>
    NodeFS.existsSync(NodePath.join(tmp, "notices.jsonl"))
      ? NodeFS.readFileSync(NodePath.join(tmp, "notices.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  env.serverJson = () =>
    JSON.parse(NodeFS.readFileSync(NodePath.join(home, "run", "server.json"), "utf8"));
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
    HBOTS_RELEASE_TEST_LOCK: NodePath.join(env.tmp, "heavy.lock"),
    HBOTS_RELEASE_TEST_TOOLS: env.tools,
    HBOTS_RELEASE_TEST_CLI: NodePath.join(HERE, "fake", "cli.mjs"),
    HBOTS_RELEASE_TEST_PORT: String(env.port),
    HBOTS_RELEASE_TEST_PINS: NodePath.join(env.tmp, "PINS.json"),
    FIXTURE_HOME: env.home,
    FIXTURE_PORT: String(env.port),
  };
  for (const [k, v] of Object.entries(c)) o[`HBOTS_RELEASE_TEST_${k}`] = String(v);
  return o;
}

// The evidence the collector would write for the fixture diff, from the real planner, with
// the e2e counts the seal reads. The seal recomputes the same plan from the repo.
function planGates(env) {
  const changed = git(
    env.repo,
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    env.rollbackFull,
    env.mainSha,
  )
    .split("\0")
    .filter(Boolean);
  const scope = planChecks(changed, { reader: gitReader(env.repo, env.mainSha) });
  return scope.plans.map((plan) => ({
    id: plan.id,
    kind: plan.id === "e2e" ? "e2e" : "node",
    mode: plan.mode,
    reason: plan.reason,
    baseSha: env.rollbackFull,
    changedPaths: scope.changedPaths,
    ...(plan.selector ? { selector: plan.selector } : {}),
    ...(plan.mode !== "skip" && plan.args ? { args: plan.args } : {}),
    ...(plan.id === "e2e" ? { counts: { journeys: 3, passed: 3 } } : {}),
    ...(plan.id === "e2e" && plan.mode !== "skip"
      ? { journeys: plan.args.map((id) => ({ id, ok: true })) }
      : {}),
  }));
}

function makeRelease(env, sha, version, { migrates, badLog }) {
  const dir = NodePath.join(env.home, "releases", sha);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(dir, "dist"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(dir, "node_modules", "fixture-pkg"), { recursive: true });
  const bin = NodePath.join(dir, "dist", "bin.mjs");
  NodeFS.writeFileSync(
    bin,
    `${NodeFS.readFileSync(NodePath.join(HERE, "fake", "server.mjs"), "utf8")}\n// build ${sha} ${version}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "node_modules", "fixture-pkg", "index.js"),
    `module.exports = ${JSON.stringify(sha)};\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "VERSION"),
    `version=${version}\nrelease=${sha}\ndirty=false\nexternals=copied\n`,
  );
  if (migrates) NodeFS.writeFileSync(NodePath.join(dir, "MIGRATES"), "");
  if (badLog) NodeFS.writeFileSync(NodePath.join(dir, "BAD_LOG"), "");
  // evidence is written last: its startedAt must be newer than every artifact file
  const startedAt = new Date(Date.now() + 1000).toISOString();
  NodeFS.writeFileSync(
    NodePath.join(dir, "gate-evidence.json"),
    JSON.stringify({
      sha: env.mainSha ?? "0".repeat(40),
      startedAt,
      finishedAt: startedAt,
      release: sha,
      binSha256: sha256(NodeFS.readFileSync(bin)),
      gates: planGates(env),
    }),
  );
  return dir;
}

export function startUnit(env, { child } = {}) {
  const unitFile = env.unitFile ?? NodePath.join(unitDir(), env.unit);
  env.unitFile = unitFile;
  const exec = `/bin/sh -c 'exec ${process.execPath} "${env.home}/releases/$$(cat ${env.home}/releases/current.txt)/dist/bin.mjs" serve'`;
  NodeFS.mkdirSync(NodePath.dirname(unitFile), { recursive: true });
  NodeFS.writeFileSync(
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
      const file = NodePath.join(dir, env.unit);
      if (isOwnedUnitFile(file, dirs) && NodeFS.existsSync(file))
        NodeFS.rmSync(file, { force: true });
    }
    if (NodeFS.existsSync(env.unitFile ?? "")) NodeFS.rmSync(env.unitFile, { force: true });
    sh("systemctl", ["--user", "daemon-reload"]);
  }
  if (env.tmp && isFixtureDir(env.tmp, cacheRoot())) {
    try {
      removeFixtureDir(env.tmp);
    } catch {
      NodeFS.rmSync(env.tmp, { recursive: true, force: true });
    }
  }
  liveEnvs.delete(env);
}

export function cleanupAll() {
  for (const env of liveEnvs) cleanup(env);
}

const isCli =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);
if (!isCli) {
  // node:test prints an empty report when after() is registered in a plain script (probes, helpers).
  if (process.env.NODE_TEST_CONTEXT) NodeTest.after(cleanupAll);
  process.once("exit", cleanupAll);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      cleanupAll();
      process.exit(128 + (NodeOS.constants.signals[signal] ?? 0));
    });
  }
}

if (isCli) {
  const dryRun = process.argv.includes("--dry-run");
  const result = reapOrphans({ dryRun });
  for (const orphan of result.orphans)
    console.log(
      `${dryRun ? "would remove" : "remove"} ${orphan.dir} units=${orphan.units.join(",") || "-"} reason=${orphan.reason}`,
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
export { sh };
export { spawn } from "node:child_process";
