// srv.mjs start <root> | stop <root> | pair <root> | fakepush <root>
// Throwaway hbots server for verify-hbots-android. Fresh data dir per run, port VERIFY_SERVER_PORT (never 38472).
// The server binary is a staged release folder, read only. It stops only the PID it recorded in <root>/srv.json.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";

const SKILL = NodePath.resolve(NodePath.dirname(new URL(import.meta.url).pathname), "..");
const SCRATCH = `${SKILL}/.scratch`;
const FAKE = NodePath.resolve(SKILL, "../../../../../scripts/personal/testing/fake-claude");
const RELEASE = process.env.VERIFY_RELEASE;
const BIN = `/home/harout/.personal-bots/releases/${RELEASE}/dist/bin.mjs`;
const PORT = Number(process.env.VERIFY_SERVER_PORT ?? 34671);
if (PORT === 38472) throw new Error("38472 is the live server");

const [cmd, ROOT] = process.argv.slice(2);
if (
  !ROOT ||
  (!NodePath.resolve(ROOT).startsWith(SCRATCH) &&
    !NodePath.resolve(ROOT).startsWith(process.env.HBOTS_VERIFY_EVIDENCE ?? SCRATCH))
) {
  console.error(
    "usage: srv.mjs start|stop|pair|fakepush <root under .scratch or the evidence folder>",
  );
  process.exit(2);
}
if (!RELEASE || !NodeFS.existsSync(BIN)) {
  console.error(`no server binary at ${BIN}`);
  process.exit(2);
}
const LIVE_DEV = "/home/harout/.personal-bots/dev";
if (NodePath.resolve(ROOT) === LIVE_DEV || NodePath.resolve(ROOT).startsWith(`${LIVE_DEV}/`)) {
  console.error("srv.mjs: refusing a data dir inside ~/.personal-bots/dev, the live hbots");
  process.exit(2);
}
const REC = `${ROOT}/srv.json`;

const env = () => ({
  PATH: "/usr/bin:/bin:" + NodePath.dirname(process.execPath),
  HOME: ROOT,
  LANG: "C.UTF-8",
  XDG_CONFIG_HOME: `${ROOT}/homes/config`,
  XDG_DATA_HOME: `${ROOT}/homes/data`,
  XDG_CACHE_HOME: `${ROOT}/homes/cache`,
  PERSONAL_SEED_MODEL: "claude-sonnet-5-5",
  // The data dir is always fresh (no restored routines or queued work), so the schedulers run, as
  // on scripts/personal/throwaway-server.ps1: a delegated task must start (flow 14, 1.67.55).
  // VERIFY_SCHEDULERS=off turns them off.
  ...(process.env.VERIFY_SCHEDULERS === "off" ? { T3CODE_PERSONAL_SCHEDULERS: "off" } : {}),
  T3CODE_PERSONAL_BROWSER_HEADLESS: "1",
  HBOTS_REBOOT_DRY_RUN: "1",
  T3CODE_AUTO_CONNECT: "false",
  T3CODE_ENVIRONMENT_LABEL: "Throwaway test",
  FAKE_CLAUDE_PID_DIR: `${ROOT}/fake-pids`,
});

function settings() {
  for (const persona of ["fakeok", "fakelimit"]) {
    const dir = `${ROOT}/fake/${persona}`,
      pkg = `${dir}/node_modules/@anthropic-ai/claude-code`;
    NodeFS.mkdirSync(pkg, { recursive: true });
    for (const f of ["cli.js", "package.json"]) NodeFS.copyFileSync(`${FAKE}/${f}`, `${pkg}/${f}`);
    NodeFS.writeFileSync(
      `${dir}/claude`,
      `#!/bin/sh\nexec '${process.execPath}' '${pkg}/cli.js' "$@"\n`,
      { mode: 0o700 },
    );
  }
  const providers = {};
  for (const key of ["claudeAgent", "codex", "deepseek", "opencode", "cursor", "grok"])
    providers[key] = { enabled: key === "claudeAgent", homePath: `${ROOT}/homes/${key}` };
  providers.claudeAgent.binaryPath = `${ROOT}/fake/fakeok/claude`;
  NodeFS.mkdirSync(`${ROOT}/userdata`, { recursive: true });
  const f = `${ROOT}/userdata/settings.json`;
  if (!NodeFS.existsSync(f)) NodeFS.writeFileSync(f, JSON.stringify({ providers }));
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(ROOT);
  } catch {
    return false;
  }
};
const rec = () => {
  try {
    return JSON.parse(NodeFS.readFileSync(REC, "utf8"));
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((y) => setTimeout(y, ms));

if (cmd === "start") {
  const r0 = rec();
  if (r0 && alive(r0.pid)) {
    console.error("already running", r0.pid);
    process.exit(1);
  }
  NodeFS.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  settings();
  const log = NodeFS.openSync(`${ROOT}/server.log`, "a", 0o600);
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      BIN,
      "serve",
      "--base-dir",
      ROOT,
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--no-browser",
    ],
    { cwd: ROOT, env: env(), detached: true, stdio: ["ignore", log, log] },
  );
  NodeFS.writeFileSync(REC, JSON.stringify({ pid: child.pid, port: PORT, release: RELEASE }));
  child.unref();
  for (let k = 0; k < 480; k++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) {
        console.log(JSON.stringify({ up: true, pid: child.pid, port: PORT, release: RELEASE }));
        process.exit(0);
      }
    } catch {}
    await sleep(250);
  }
  console.error("server did not come up");
  process.exit(1);
} else if (cmd === "stop") {
  const r = rec();
  if (!r || !alive(r.pid)) {
    console.log("not running");
    process.exit(0);
  }
  try {
    process.kill(-r.pid, "SIGTERM");
  } catch {
    process.kill(r.pid, "SIGTERM");
  }
  for (let k = 0; k < 60 && alive(r.pid); k++) await sleep(250);
  if (alive(r.pid)) {
    try {
      process.kill(-r.pid, "SIGKILL");
    } catch {
      process.kill(r.pid, "SIGKILL");
    }
  }
  console.log("stopped", r.pid);
} else if (cmd === "pair") {
  const out = NodeChildProcess.execFileSync(
    process.execPath,
    [BIN, "pair", "--base-dir", ROOT, "--ttl", "15m"],
    {
      env: env(),
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  const t = out.match(/^\s*Token:\s*(\S+)/m);
  if (!t) throw new Error("no token");
  console.log(`http://127.0.0.1:${PORT}/pair#token=${t[1]}`);
} else if (cmd === "fakepush") {
  const db = new NodeSqlite.DatabaseSync(`${ROOT}/userdata/statev2.sqlite`);
  const ecdh = NodeCrypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const now = new Date().toISOString();
  const session = db
    .prepare(
      "SELECT session_id FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(now);
  if (!session) {
    console.error("fakepush: no live auth session (pair first)");
    process.exit(1);
  }
  db.prepare(
    "INSERT OR REPLACE INTO personal_push_subscriptions (subscription_id, endpoint, p256dh, auth, device_label, created_at, updated_at, auth_session_id) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    "verify-fake-sub",
    "https://127.0.0.1:9/verify-fake",
    ecdh.getPublicKey().toString("base64url"),
    NodeCrypto.randomBytes(16).toString("base64url"),
    "Verify fake recipient",
    now,
    now,
    session.session_id,
  );
  console.log("fakepush ok");
} else {
  console.error("start|stop|pair|fakepush");
  process.exit(2);
}
