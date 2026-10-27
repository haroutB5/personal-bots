// Builds a throwaway world for the runner: a fake HOME with releases, a fake server running in a real (but
// throwaway) systemd user unit, a temp git repo, stub dev-team tools, an app sheet, and the test overrides.
// Everything lives under ~/.cache/hbots-release-fixture-* (btrfs, so the reflink backup path is exercised).
// Nothing here points at the live hbots data: dev/ and prod/ of the real ~/.personal-bots are never used.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import { makeFixtureDb } from "../lib/fixture.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(HERE);
export const RUNNER = path.join(ROOT, "hbots-release.mjs");
export const LAUNCHER = path.join(ROOT, "hbots-release-launch.mjs");
const REAL_TOOLS = "/home/harout/Claude/AI/dev-team/tools";
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const MIGRATIONS = (max) => `export const migrations = [\n${Array.from({ length: max }, (_, i) => `  [${i + 1}, "m${i + 1}", Layer],`).join("\n")}\n];\n`;

function git(repo, ...args) {
  const r = sh("git", ["-C", repo, "-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", ...args]);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export async function makeEnv({ name = "t", baselineVersion = "9.9.0", targetVersion = "9.9.1", migrateTo = 113, constants = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.homedir(), ".cache", `hbots-release-fixture-${name}-`));
  const home = path.join(tmp, ".personal-bots"); // the runner's HOME is tmp; cfg.home = tmp/.personal-bots
  const port = await freePort();
  const unit = `hbots-fixture-${path.basename(tmp).split("-").pop()}.service`;
  for (const d of ["run", "releases", "logs", "backups", "flags", "dev/userdata/logs/provider", "dev/runtime", "tools", "docs"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  const env = { tmp, home, port, unit, baselineVersion, targetVersion, constants };

  // git repo: commit 1 = rollback baseline, commit 2 = the notes commit
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "apps/server/src/persistence"), { recursive: true });
  fs.mkdirSync(path.join(repo, "apps/server/src/personal/tasks"), { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts/personal/node"), { recursive: true });
  sh("git", ["init", "-q", repo]);
  const write = (rel, text) => fs.writeFileSync(path.join(repo, rel), text);
  write("apps/server/src/personal/tasks/PersonalTaskService.ts", "export const PERSONAL_TASKS_CONCURRENCY = 5;\n");
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
  for (const f of ["check-release-notes.mjs", "check-gate-evidence.mjs", "gate-common.mjs", "ops-common.mjs", "notify-release.mjs"]) fs.copyFileSync(path.join(REAL_TOOLS, f), path.join(tools, f));
  const flags = path.join(home, "flags");
  const stub = (file, body) => fs.writeFileSync(path.join(tools, file), `import fs from "node:fs";\n${body}\n`);
  stub("check-release-notes.mjs", `if (fs.existsSync(${JSON.stringify(path.join(flags, "notes-fail"))})) { console.error("notes missing"); process.exit(1); }\nconsole.log("PASS: stub notes check");`);
  stub("check-gate-evidence.mjs", `if (fs.existsSync(${JSON.stringify(path.join(flags, "evidence-fail"))})) { console.error("evidence failed"); process.exit(1); }\nconsole.log("PASS: stub evidence check");`);
  stub("notify-release.mjs", `fs.appendFileSync(${JSON.stringify(path.join(tmp, "notices.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");\nconsole.log("notice recorded");`);
  env.tools = tools;

  // app sheet + history
  env.sheet = path.join(tmp, "app.md");
  env.history = path.join(tmp, "history.md");
  fs.writeFileSync(env.sheet, `# App\n\n- Live: **v${baselineVersion}** live since 2026-10-01 10:00:00 BST (release ${env.rollback}). Release logs and old live lines: \`apps/personal-bots-history.md\`.\n`);
  fs.writeFileSync(env.history, "# History\n\n## 1. Old live line (was line 3)\n\n");

  // releases: baseline (live) and target
  env.makeRelease = (sha, version, { migrates = false, badLog = false } = {}) => makeRelease(env, sha, version, { migrates, badLog });
  makeRelease(env, env.rollback, baselineVersion, {});
  fs.writeFileSync(path.join(home, "releases", "current.txt"), `${env.rollback}\n`);
  if (migrateTo > 113) {
    makeFixtureDb(path.join(home, "dev", "userdata", "state.sqlite"), 113);
    fs.mkdirSync(path.join(home, "dev", "userdata", "secrets"), { recursive: true });
    fs.mkdirSync(path.join(home, "dev", "userdata", "attachments"), { recursive: true });
    fs.writeFileSync(path.join(home, "dev", "userdata", "attachments", "a.txt"), "x");
  }
  env.target = (opts = {}) => makeRelease(env, env.release, targetVersion, { migrates: migrateTo > 113, ...opts });
  env.overrides = overrides(env);
  env.args = (extra = []) => ["--release", env.release, "--rollback", env.rollback, "--main-sha", env.mainSha, "--version", targetVersion, "--notify-thread", env.thread, "--migration-before", "113", "--migration-after", String(migrateTo), "--repo-root", repo, "--app-sheet", env.sheet, "--app-history", env.history, "--stable-seconds", "2", ...extra];
  env.node = process.execPath;
  env.processEnv = () => ({ ...process.env, HOME: tmp, ...env.overrides });
  env.runner = (mode, extra = [], opts = {}) => sh(env.node, [RUNNER, ...(mode ? [mode] : []), ...env.args(extra)], { env: env.processEnv(), timeout: 600_000, ...opts });
  env.launch = (mode, extra = [], opts = {}) => sh(env.node, [LAUNCHER, ...(mode ? [mode] : []), ...env.args(extra)], { env: env.processEnv(), timeout: 600_000, ...opts });
  env.result = (mode = "") => JSON.parse(fs.readFileSync(path.join(home, "run", `restart-${targetVersion}${{ "": "", "--dry-run": "-dryrun", "--prepare": "-prepare", "--guards-only": "-guards" }[mode]}-result.json`), "utf8"));
  env.flag = (n) => fs.writeFileSync(path.join(flags, n), "1");
  env.notices = () => (fs.existsSync(path.join(tmp, "notices.jsonl")) ? fs.readFileSync(path.join(tmp, "notices.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  env.serverJson = () => JSON.parse(fs.readFileSync(path.join(home, "run", "server.json"), "utf8"));
  env.start = (opts) => startUnit(env, opts);
  env.stop = () => cleanup(env);
  env.writePins = () => sh(env.node, [RUNNER, "--write-pins"], { env: env.processEnv() });
  return env;
}

function overrides(env) {
  const c = { LOOK_MS: 700, QUIET_LOOKS: 2, EVENTS_QUIET_MS: 1500, CPU_BUDGET_S: 5, MARATHON_MS: 90_000, START_TIMEOUT_MS: 40_000, ...env.constants };
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
  fs.writeFileSync(bin, `${fs.readFileSync(path.join(HERE, "fake", "server.mjs"), "utf8")}\n// build ${sha} ${version}\n`);
  fs.writeFileSync(path.join(dir, "node_modules", "fixture-pkg", "index.js"), `module.exports = ${JSON.stringify(sha)};\n`);
  fs.writeFileSync(path.join(dir, "VERSION"), `version=${version}\nrelease=${sha}\ndirty=false\nexternals=copied\n`);
  if (migrates) fs.writeFileSync(path.join(dir, "MIGRATES"), "");
  if (badLog) fs.writeFileSync(path.join(dir, "BAD_LOG"), "");
  // evidence is written last: its startedAt must be newer than every artifact file
  const startedAt = new Date(Date.now() + 1000).toISOString();
  fs.writeFileSync(path.join(dir, "gate-evidence.json"), JSON.stringify({ sha: env.mainSha ?? "0".repeat(40), startedAt, finishedAt: startedAt, release: sha, binSha256: sha256(fs.readFileSync(bin)), gates: [{ id: "e2e", counts: { journeys: 3, passed: 3 } }] }));
  return dir;
}

export function startUnit(env, { child } = {}) {
  const unitFile = path.join(os.homedir(), ".config", "systemd", "user", env.unit);
  const exec = `/bin/sh -c 'exec ${process.execPath} "${env.home}/releases/$$(cat ${env.home}/releases/current.txt)/dist/bin.mjs" serve'`;
  fs.mkdirSync(path.dirname(unitFile), { recursive: true });
  fs.writeFileSync(unitFile, `[Unit]\nDescription=hbots release runner fixture server (throwaway)\n\n[Service]\nType=simple\nEnvironment=FIXTURE_HOME=${env.home}\nEnvironment=FIXTURE_PORT=${env.port}\n${child === undefined ? "" : `Environment="FIXTURE_CHILD=${child}"\n`}ExecStart=${exec}\nKillMode=control-group\nCPUAccounting=yes\nMemoryAccounting=yes\n`);
  env.unitFile = unitFile;
  sh("systemctl", ["--user", "daemon-reload"]);
  const r = sh("systemctl", ["--user", "start", env.unit]);
  if (r.status !== 0) throw new Error(`could not start ${env.unit}: ${r.stderr}`);
}

export function cleanup(env) {
  if (env.unit) sh("systemctl", ["--user", "stop", env.unit]);
  for (const u of sh("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", "hbots-release-*"]).stdout.split("\n")) {
    const n = u.trim().split(/\s+/)[0];
    if (n && n.includes(env.targetVersion)) sh("systemctl", ["--user", "stop", n]);
  }
  if (env.unitFile) fs.rmSync(env.unitFile, { force: true });
  sh("systemctl", ["--user", "daemon-reload"]);
  if (env.tmp?.includes("hbots-release-fixture-")) fs.rmSync(env.tmp, { recursive: true, force: true });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sh, spawn };
