// Fixture tests for the Linux release runner. Run: node --NodeTest.test --NodeTest.test-concurrency=1 tests/
// Wrapped by the heavy-job lock: bash dev-team/tools/heavy-job.sh --label hbots-release-tests -- node --NodeTest.test ...
// Each case builds its own throwaway world (tests/env.mjs); nothing touches the live hbots service or data.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import { copyStopped, liveSizes, verifyBackup, writeManifest } from "../lib/backup.mjs";
import { makeFixtureDb } from "../lib/fixture.mjs";
import {
  cacheRoot,
  configUnitDir,
  makeEnv,
  procStart,
  reapOrphans,
  sh,
  sleep,
  ROOT,
  spawn,
} from "./env.mjs";
import { prepared } from "./prepare.mjs";

// Child reports and the generated child test live in scratch. Fixtures use the harness defaults
// (~/.cache and ~/.config/systemd/user) unless the caller sets the sandbox env for this run.
const SCRATCH = NodePath.join(
  NodePath.resolve(ROOT, "../../../.."),
  ".tmp",
  "release-fixture-tests",
);
NodeFS.mkdirSync(SCRATCH, { recursive: true });
const RUNTIME_UNIT_DIR =
  process.env.HBOTS_RELEASE_FIXTURE_RUNTIME_DIR ||
  NodePath.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "systemd", "user");

// The unit name carries a hash of its cache dir. Compute it here so the test checks the naming
// contract without reading it back from the code that writes it.
const unitTag = (dir) =>
  NodeCrypto.createHash("sha256").update(NodePath.resolve(dir)).digest("hex").slice(0, 8);

const TERMINAL = [
  "live_verified",
  "live_verified_doc_update_failed",
  "rolled_back",
  "rollback_failed",
  "failed",
];

async function waitResult(env, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const j = env.result();
      if (TERMINAL.includes(j.status) && j.mode === "run") {
        await sleep(600); // notice and final save
        return env.result();
      }
    } catch {}
    await sleep(300);
  }
  throw new Error("runner did not finish in time");
}

function unitLoaded(unit) {
  return (
    sh("systemctl", [
      "--user",
      "list-units",
      "--all",
      "--plain",
      "--no-legend",
      unit,
    ]).stdout.trim() !== ""
  );
}

async function pidGone(pid, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") return true;
      throw e;
    }
    await sleep(100);
  }
  return false;
}

async function waitFor(fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(100);
  }
  throw new Error("timed out waiting for the fixture");
}

const CHILD_SCRIPT = NodePath.join(SCRATCH, "fixture-child.mjs");
const envUrl = (file) => NodeURL.pathToFileURL(NodePath.join(ROOT, file)).href;
NodeFS.writeFileSync(
  CHILD_SCRIPT,
  `import * as NodeTest from "node:test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { prepared } from ${JSON.stringify(envUrl("tests/prepare.mjs"))};

const mode = process.env.FIXTURE_CHILD_MODE;
const info = process.env.FIXTURE_CHILD_INFO;
const write = (env, extra = {}) =>
  NodeFS.writeFileSync(info, JSON.stringify({ ownerPid: process.pid, record: JSON.parse(NodeFS.readFileSync(NodePath.join(env.tmp, "fixture.json"), "utf8")), dir: env.tmp, unit: env.unit, unitFile: env.unitFile, home: env.home, ...extra }));

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout");
}

NodeTest.test("fixture " + mode, async (t) => {
  if (mode === "prepare-fail") {
    await prepared(t, {}, async (env) => {
      await waitFor(() => NodeFS.existsSync(NodePath.join(env.home, "run", "server.json")), 30_000);
      write(env, { serverPid: env.serverJson().pid, unitText: NodeFS.readFileSync(env.unitFile, "utf8") });
      env.flag("notes-fail");
    });
    return;
  }
  const env = await prepared(t);
  await waitFor(() => NodeFS.existsSync(NodePath.join(env.home, "run", "server.json")), 30_000);
  write(env, { serverPid: env.serverJson().pid, unitText: NodeFS.readFileSync(env.unitFile, "utf8") });
  if (mode === "pass") return;
  if (mode === "fail") throw new Error("deliberate test failure");
  if (mode === "hold") await new Promise(() => {});
});
`,
);

function runChild(mode, info) {
  return sh(process.execPath, [CHILD_SCRIPT], {
    env: { ...process.env, FIXTURE_CHILD_MODE: mode, FIXTURE_CHILD_INFO: info },
    timeout: 180_000,
  });
}

const REAPER_SPIN_SCRIPT = NodePath.join(SCRATCH, "fixture-reaper-spin.mjs");
NodeFS.writeFileSync(
  REAPER_SPIN_SCRIPT,
  `import * as NodeFS from "node:fs";
import { reapOrphans } from ${JSON.stringify(envUrl("tests/env.mjs"))};
const end = Date.now() + Number(process.argv[2]);
const removed = [];
while (Date.now() < end) {
  for (const p of reapOrphans().removed) removed.push(p);
}
NodeFS.writeFileSync(process.argv[3], JSON.stringify(removed));
`,
);

NodeTest.test("prepare, guards-only and dry-run pass and do not restart the server", async (t) => {
  const env = await prepared(t);
  try {
    const pid = env.serverJson().pid;
    let r = env.runner("--guards-only");
    NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
    NodeAssert.equal(env.result("--guards-only").status, "guards_ok");
    r = env.runner("--dry-run");
    NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
    const j = env.result("--dry-run");
    NodeAssert.equal(j.status, "dryrun_ok");
    NodeAssert.ok(j.plan.rows.length >= 5 && j.plan.low > 0, "dry run prints a timed plan");
    NodeAssert.match(r.stdout, /EXPECTED arm -> verified/);
    NodeAssert.equal(env.serverJson().pid, pid, "server was not restarted");
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(env.home, "releases", "current.txt"), "utf8").trim(),
      env.rollback,
    );
    // the seal and the tools copy are the Linux equivalents of the Windows -Prepare output
    NodeAssert.ok(
      NodeFS.existsSync(NodePath.join(env.home, "run", `hbots-${env.targetVersion}-seal.json`)),
    );
    NodeAssert.ok(
      NodeFS.existsSync(
        NodePath.join(
          env.home,
          "run",
          `release-tools-${env.targetVersion}`,
          "scripts",
          "personal",
          "node",
          "hbots.mjs",
        ),
      ),
    );
  } finally {
    env.stop();
  }
});

NodeTest.test(
  "dry-run --verify-live checks a release that is already live, read-only",
  async (t) => {
    const env = await prepared(t);
    try {
      // make the target the live release the way a finished run would have
      NodeFS.writeFileSync(NodePath.join(env.home, "releases", "current.txt"), `${env.release}\n`);
      sh("systemctl", ["--user", "restart", env.unit]);
      await sleep(1500);
      const pid = env.serverJson().pid;
      const r = env.runner("--dry-run", ["--verify-live"]);
      NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
      NodeAssert.match(r.stdout, /Smoke PASSED|smoke .*PASSED/);
      NodeAssert.equal(env.serverJson().pid, pid, "verify-live must not restart");
    } finally {
      env.stop();
    }
  },
);

NodeTest.test(
  "full cycle through the launcher: ARMED, detached runner survives the restart, result JSON, notice, sheet",
  async (t) => {
    const env = await prepared(t);
    try {
      const before = env.serverJson().pid;
      const r = env.launch(null);
      NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
      NodeAssert.match(r.stdout, /^ARMED status=/m);
      const j = await waitResult(env);
      NodeAssert.equal(j.status, "live_verified", j.error);
      NodeAssert.equal(j.verifiedAt != null && j.activatedAt != null && j.idleAt != null, true);
      NodeAssert.equal(j.restartExit, 0);
      NodeAssert.equal(j.smokeExit, 0);
      NodeAssert.equal(j.liveVersion, env.targetVersion);
      NodeAssert.equal(j.backupSkipped, true);
      NodeAssert.ok(j.timings.armToVerified > 0 && j.timings.restartToVerified > 0);
      NodeAssert.ok(j.selfStats.peakRssMb > 0 && j.selfStats.cpuSeconds >= 0);
      NodeAssert.notEqual(env.serverJson().pid, before);
      NodeAssert.equal(env.serverJson().release, env.release);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(env.home, "releases", "current.txt"), "utf8").trim(),
        env.release,
      );
      NodeAssert.ok(
        NodeFS.existsSync(NodePath.join(env.home, "dev", "runtime", "desktop-update-restart")),
        "tunnel marker written",
      );
      const notes = env.notices();
      NodeAssert.equal(notes.length, 1);
      NodeAssert.equal(notes[0][notes[0].indexOf("--outcome") + 1], "live");
      NodeAssert.equal(notes[0][notes[0].indexOf("--thread-id") + 1], env.thread);
      NodeAssert.match(
        NodeFS.readFileSync(env.sheet, "utf8"),
        new RegExp(`\\*\\*v${env.targetVersion.replace(/\./g, "\\.")}\\*\\* live since`),
      );
      NodeAssert.match(
        NodeFS.readFileSync(env.history, "utf8"),
        new RegExp(`\\*\\*v${env.baselineVersion.replace(/\./g, "\\.")}\\*\\*`),
      );
      // the heavy-job lock is free again
      NodeAssert.equal(sh("flock", ["-n", NodePath.join(env.tmp, "heavy.lock"), "true"]).status, 0);
      // a leftover waiter unit must not remain
      const units = sh("systemctl", [
        "--user",
        "list-units",
        "--all",
        "--plain",
        "--no-legend",
        `hbots-release-run-${env.targetVersion}*`,
      ]).stdout.trim();
      NodeAssert.equal(units, "");
    } finally {
      env.stop();
    }
  },
);

NodeTest.test(
  "forced smoke failure rolls the binary back, restarts the old release, sends a rolled_back notice",
  async (t) => {
    const env = await prepared(t);
    try {
      env.flag(`fail-smoke-${env.release}`);
      const r = env.launch(null);
      NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
      const j = await waitResult(env);
      NodeAssert.equal(j.status, "rolled_back", j.error);
      NodeAssert.equal(j.rollbackExit, 0);
      NodeAssert.equal(j.rollbackSmokeExit, 0);
      NodeAssert.equal(env.serverJson().release, env.rollback);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(env.home, "releases", "current.txt"), "utf8").trim(),
        env.rollback,
      );
      const n = env.notices()[0];
      NodeAssert.equal(n[n.indexOf("--outcome") + 1], "rolled_back");
      NodeAssert.equal(n[n.indexOf("--rollback-release") + 1], env.rollback);
      NodeAssert.match(
        NodeFS.readFileSync(env.sheet, "utf8"),
        new RegExp(`\\*\\*v${env.baselineVersion.replace(/\./g, "\\.")}\\*\\*`),
        "sheet unchanged",
      );
    } finally {
      env.stop();
    }
  },
);

NodeTest.test("a startup error in the log fails the extended checks and rolls back", async (t) => {
  const env = await prepared(t, { target: { badLog: true } });
  try {
    const r = env.launch(null);
    NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
    const j = await waitResult(env);
    NodeAssert.equal(j.status, "rolled_back");
    NodeAssert.match(j.error, /error lines/);
  } finally {
    env.stop();
  }
});

NodeTest.test("rollback that also fails its smoke is reported as rollback_failed", async (t) => {
  const env = await prepared(t);
  try {
    env.flag(`fail-smoke-${env.release}`);
    env.flag(`fail-smoke-${env.rollback}`);
    env.launch(null);
    const j = await waitResult(env);
    NodeAssert.equal(j.status, "rollback_failed");
    const n = env.notices()[0];
    NodeAssert.equal(n[n.indexOf("--outcome") + 1], "rollback_failed");
  } finally {
    env.stop();
  }
});

NodeTest.test(
  "idle wait: recent event-log activity delays the restart; no restart while busy",
  async (t) => {
    const env = await prepared(t);
    try {
      const events = NodePath.join(
        env.home,
        "dev",
        "userdata",
        "logs",
        "provider",
        "events.thread.log",
      );
      const pid = env.serverJson().pid;
      let busy = true;
      const toucher = (async () => {
        while (busy) {
          NodeFS.writeFileSync(events, `${Date.now()}\n`);
          await sleep(300);
        }
      })();
      const t0 = Date.now();
      const r = env.launch(null);
      NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
      await sleep(6000);
      NodeAssert.equal(env.serverJson().pid, pid, "still on the old server while events are fresh");
      NodeAssert.equal(env.result().status, "waiting_for_idle");
      busy = false;
      await toucher;
      const j = await waitResult(env);
      NodeAssert.equal(j.status, "live_verified", j.error);
      NodeAssert.ok(
        j.idleLooks.some((l) => l.busyReason?.includes("events=")),
        "busy looks are recorded",
      );
      NodeAssert.ok(Date.parse(j.activatedAt) - t0 > 6000);
    } finally {
      env.stop();
    }
  },
);

NodeTest.test(
  "busy tools: only the server's cgroup counts, never a sibling Chromium scope",
  async (t) => {
    const env = await makeEnv();
    t.after(() => env.stop());
    const scope = `chromium-fixture-${env.port}`;
    let scoped;
    try {
      // one process inside the unit's cgroup (the server's child), one outside in its own scope
      env.start({ child: "sleep 301" });
      scoped = spawn(
        "systemd-run",
        ["--user", "--scope", "--quiet", "--collect", `--unit=${scope}`, "--", "sleep", "302"],
        { stdio: "ignore" },
      );
      await sleep(1500);
      const { loadConfig } = await import("../lib/config.mjs");
      const { takeLook } = await import("../lib/idle.mjs");
      const look = takeLook(loadConfig(env.processEnv()), null);
      NodeAssert.equal(look.serverRunning, true);
      NodeAssert.match(look.cgDir, new RegExp(env.unit.replaceAll(".", "\\.")));
      const cmds = look.toolProcs.map((p) => p.cmd).join("\n");
      NodeAssert.match(cmds, /sleep 301/, "a process in hbots.service's cgroup is hbots work");
      NodeAssert.doesNotMatch(cmds, /sleep 302/, "a process in its own scope is not hbots work");
    } finally {
      scoped?.kill("SIGTERM");
      sh("systemctl", ["--user", "stop", `${scope}.scope`]);
      env.stop();
    }
  },
);

NodeTest.test("waiting for idle tells Harout on the desktop and in his chat, once", async (t) => {
  const env = await makeEnv({ constants: { WAITING_ALERT_MINUTES: "0" } });
  t.after(() => env.stop());
  const bin = NodePath.join(env.tmp, "fakebin");
  const notifyLog = NodePath.join(env.tmp, "notify.log");
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(
    NodePath.join(bin, "notify-send"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${notifyLog}'\n`,
    { mode: 0o755 },
  );
  try {
    env.start({ child: "sleep 302" });
    env.target();
    env.writePins();
    // Inside the detached unit PATH is systemd's, not this NodeTest.test's: point the
    // runner's notifier at the recorder explicitly.
    env.overrides.HBOTS_RELEASE_TEST_NOTIFY_SEND = NodePath.join(bin, "notify-send");
    const prep = env.runner("--prepare");
    NodeAssert.equal(prep.status, 0, prep.stdout + prep.stderr);
    const launched = env.launch(null);
    NodeAssert.equal(launched.status, 0, launched.stdout + launched.stderr);
    const inbox = NodePath.join(env.home, "dev", "personal", "release-notices");
    const deadline = Date.now() + 30_000;
    while (
      Date.now() < deadline &&
      !(NodeFS.existsSync(inbox) && NodeFS.readdirSync(inbox).length > 0)
    ) {
      await sleep(200);
    }
    const notices = NodeFS.readdirSync(inbox).filter((name) => name.endsWith(".json"));
    NodeAssert.equal(notices.length, 1, `one waiting notice: ${notices.join(", ")}`);
    const notice = JSON.parse(NodeFS.readFileSync(NodePath.join(inbox, notices[0]), "utf8"));
    NodeAssert.equal(notice.outcome, "waiting");
    NodeAssert.equal(notice.threadId, env.thread);
    NodeAssert.match(notice.detail, /sleep 302/);
    NodeAssert.match(notice.logPath, /restart-9\.9\.1\.log$/);
    // The desktop toast is critical (a normal one expires in seconds), short,
    // and sent as omarchy-action: the one app name Omarchy lets past Do Not Disturb.
    const toast = NodeFS.readFileSync(notifyLog, "utf8");
    NodeAssert.match(toast, /--urgency=critical/);
    NodeAssert.match(toast, /--app-name=omarchy-action/);
    NodeAssert.match(toast, /hbots 9\.9\.1 release is waiting \(0 min\): /);
    NodeAssert.doesNotMatch(toast, /; .*; .*; /, "the toast names one blocker, not a pid dump");
    const result = env.result();
    NodeAssert.equal(result.waitingAlert.minutes, 0);
    NodeAssert.match(result.waitingAlert.noticeFile, /-waiting-\d+-0\.json$/);
    // A second look must not deliver it again.
    await sleep(1_600);
    NodeAssert.equal(NodeFS.readdirSync(inbox).filter((name) => name.endsWith(".json")).length, 1);
    // Let the wait finish: kill only the child this NodeTest.test started.
    const childPid = Number(
      NodeFS.readFileSync(NodePath.join(env.home, "run", "fixture-child.pid"), "utf8"),
    );
    process.kill(childPid, "SIGTERM");
    const j = await waitResult(env);
    NodeAssert.equal(j.status, "live_verified", j.error);
  } finally {
    env.stop();
  }
});

NodeTest.test(
  "heavy-job lock: waits while another job holds it, never restarts mid-build",
  async (t) => {
    const env = await prepared(t);
    try {
      const lock = NodePath.join(env.tmp, "heavy.lock");
      NodeFS.writeFileSync(lock, "pid=0 label=fixture-build\n");
      const holder = spawn("flock", ["-n", lock, "sleep", "8"], { stdio: "ignore" }); // a process this NodeTest.test started
      await sleep(500);
      const pid = env.serverJson().pid;
      const t0 = Date.now();
      env.launch(null);
      await sleep(5000);
      NodeAssert.equal(env.serverJson().pid, pid, "no restart while the lock is held");
      NodeAssert.match(JSON.stringify(env.result().idleLooks ?? []), /heavy-lock/);
      holder.kill("SIGTERM");
      const j = await waitResult(env);
      NodeAssert.equal(j.status, "live_verified", j.error);
      NodeAssert.ok(
        Date.parse(j.activatedAt) - t0 > 5000,
        "activated only after the lock was freed",
      );
    } finally {
      env.stop();
    }
  },
);

NodeTest.test("the runner waits for both heavy-job slots", async (t) => {
  const env = await prepared(t);
  const heavy = NodePath.join(ROOT, "..", "dev-team-tools", "heavy-job.sh");
  const base = NodePath.join(env.tmp, "heavy");
  const jobEnv = {
    ...process.env,
    HEAVY_JOB_BASE: base,
    HEAVY_JOB_MEMORY_HIGH: "off",
    HEAVY_JOB_MIN_FREE_GB: "0",
    HEAVY_JOB_SLOTS: "2",
  };
  const start = (label) =>
    new Promise((resolve) => {
      const p = spawn("bash", [heavy, "--label", label, "--", "sleep", "12"], {
        stdio: ["ignore", "ignore", "pipe"],
        env: jobEnv,
      });
      p.stderr.on("data", (d) => {
        if (/nice 10/.test(String(d))) resolve(p);
      });
    });
  const a = await start("slot alpha");
  const b = await start("slot beta");
  try {
    const pid = env.serverJson().pid;
    const r = env.launch(null);
    NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
    await sleep(4000);
    NodeAssert.equal(env.serverJson().pid, pid, "no restart while both slots run");
    const waiting = env.result();
    NodeAssert.equal(waiting.status, "waiting_for_idle");
    NodeAssert.match(JSON.stringify(waiting.idleLooks ?? []), /heavy-lock/);
    NodeAssert.match(JSON.stringify(waiting.blockers ?? []), /slot (alpha|beta)/);
    NodeAssert.match(
      JSON.stringify(waiting.blockers ?? []),
      /slot alpha[\s\S]*slot beta|slot beta[\s\S]*slot alpha/,
    );
  } finally {
    a.kill("SIGTERM");
    b.kill("SIGTERM");
  }
  const j = await waitResult(env);
  NodeAssert.equal(j.status, "live_verified", j.error);
  env.stop();
  NodeAssert.equal(NodeFS.existsSync(env.tmp), false, "heavy-slot fixture dir removed");
  NodeAssert.equal(NodeFS.existsSync(env.unitFile), false, "heavy-slot unit file removed");
  NodeAssert.equal(unitLoaded(env.unit), false, "heavy-slot fixture unit stopped");
});

NodeTest.test(
  "a fixture stops and is removed after a passing, failing or prepare-failed test",
  async () => {
    for (const mode of ["pass", "fail", "prepare-fail"]) {
      const info = NodePath.join(
        SCRATCH,
        `info-${process.pid}-${mode}-${NodeCrypto.randomBytes(3).toString("hex")}.json`,
      );
      const r = runChild(mode, info);
      if (mode === "pass") NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
      else NodeAssert.notEqual(r.status, 0, `${mode} child must fail`);
      NodeAssert.equal(
        NodeFS.existsSync(info),
        true,
        `${mode}: child did not report its fixture\n${r.stdout}${r.stderr}`,
      );
      const j = JSON.parse(NodeFS.readFileSync(info, "utf8"));
      NodeAssert.equal(j.record.schema, 1);
      NodeAssert.equal(j.record.unit, j.unit);
      NodeAssert.equal(j.record.dir, j.dir);
      NodeAssert.equal(j.record.ownerPid, j.ownerPid);
      NodeAssert.equal(typeof j.record.ownerStart, "string");
      NodeAssert.equal(NodeFS.existsSync(j.dir), false, `${mode}: fixture dir ${j.dir} removed`);
      NodeAssert.equal(
        NodeFS.existsSync(j.unitFile),
        false,
        `${mode}: unit file ${j.unitFile} removed`,
      );
      NodeAssert.equal(unitLoaded(j.unit), false, `${mode}: unit ${j.unit} stopped`);
      NodeAssert.equal(await pidGone(j.serverPid), true, `${mode}: server pid ${j.serverPid} gone`);
      if (mode === "pass") {
        NodeAssert.match(j.unitText, /RuntimeMaxSec=900/, "unit has a hard runtime ceiling");
        NodeAssert.doesNotMatch(
          j.unitText,
          /CPUAccounting/,
          "the ignored accounting switch is gone",
        );
        NodeAssert.equal(
          NodePath.dirname(j.unitFile),
          RUNTIME_UNIT_DIR,
          "unit file lives in the runtime dir",
        );
      }
      NodeFS.rmSync(info, { force: true });
    }
  },
);

NodeTest.test("the reaper removes a fixture left by a SIGKILLed test on the next run", async () => {
  const info = NodePath.join(
    SCRATCH,
    `info-killed-${process.pid}-${NodeCrypto.randomBytes(3).toString("hex")}.json`,
  );
  const child = spawn(process.execPath, [CHILD_SCRIPT], {
    env: { ...process.env, FIXTURE_CHILD_MODE: "hold", FIXTURE_CHILD_INFO: info },
    stdio: "ignore",
  });
  const exit = new Promise((resolve) => child.once("exit", resolve));
  let dead = false;
  try {
    await waitFor(() => NodeFS.existsSync(info), 60_000);
    const j = JSON.parse(NodeFS.readFileSync(info, "utf8"));
    NodeAssert.equal(NodeFS.existsSync(j.dir), true, "fixture dir exists before the kill");
    NodeAssert.equal(unitLoaded(j.unit), true, "fixture unit is live before the kill");
    child.kill("SIGKILL");
    await exit;
    dead = true;
    NodeAssert.equal(NodeFS.existsSync(j.dir), true, "the SIGKILL left the fixture dir behind");
    NodeAssert.equal(unitLoaded(j.unit), true, "the SIGKILL left the fixture unit running");
    const nextInfo = NodePath.join(
      SCRATCH,
      `info-next-${process.pid}-${NodeCrypto.randomBytes(3).toString("hex")}.json`,
    );
    const next = runChild("pass", nextInfo);
    NodeAssert.equal(next.status, 0, next.stdout + next.stderr);
    NodeAssert.equal(NodeFS.existsSync(j.dir), false, "next run removed the killed fixture dir");
    NodeAssert.equal(NodeFS.existsSync(j.unitFile), false, "next run removed the killed unit file");
    NodeAssert.equal(unitLoaded(j.unit), false, "next run stopped the killed unit");
    NodeAssert.equal(await pidGone(j.serverPid), true, `fixture server pid ${j.serverPid} gone`);
    NodeFS.rmSync(info, { force: true });
    NodeFS.rmSync(nextInfo, { force: true });
  } finally {
    if (!dead) {
      child.kill("SIGKILL");
      await exit;
    }
  }
});

NodeTest.test("the reaper never touches a fixture whose owner is alive", () => {
  const cache = cacheRoot();
  const config = configUnitDir();
  NodeFS.mkdirSync(cache, { recursive: true });
  NodeFS.mkdirSync(config, { recursive: true });
  const liveDir = NodeFS.mkdtempSync(NodePath.join(cache, "hbots-release-fixture-live-"));
  const suffix = NodePath.basename(liveDir).split("-").pop();
  const unit = `hbots-fixture-${suffix}.service`;
  const unitFile = NodePath.join(config, unit);
  NodeFS.writeFileSync(unitFile, "[Unit]\nDescription=live owner fixture\n");
  const record = {
    schema: 1,
    unit,
    unitFile,
    dir: liveDir,
    port: 0,
    ownerPid: process.pid,
    ownerStart: procStart(process.pid),
    createdAt: new Date().toISOString(),
  };
  NodeFS.writeFileSync(NodePath.join(liveDir, "fixture.json"), JSON.stringify(record));

  const deadDir = NodeFS.mkdtempSync(NodePath.join(cache, "hbots-release-fixture-dead-"));
  const deadUnit = `hbots-fixture-${NodePath.basename(deadDir).split("-").pop()}.service`;
  const deadUnitFile = NodePath.join(config, deadUnit);
  NodeFS.writeFileSync(deadUnitFile, "[Unit]\nDescription=dead owner fixture\n");
  NodeFS.writeFileSync(
    NodePath.join(deadDir, "fixture.json"),
    JSON.stringify({
      ...record,
      unit: deadUnit,
      unitFile: deadUnitFile,
      dir: deadDir,
      ownerPid: 99999999,
    }),
  );

  try {
    const r = reapOrphans();
    NodeAssert.ok(
      r.live.some((f) => f.dir === liveDir),
      "the live fixture is skipped",
    );
    NodeAssert.equal(NodeFS.existsSync(liveDir), true, "live fixture dir untouched");
    NodeAssert.equal(NodeFS.existsSync(unitFile), true, "live unit file untouched");
    NodeAssert.equal(NodeFS.existsSync(deadDir), false, "dead fixture dir removed");
    NodeAssert.equal(NodeFS.existsSync(deadUnitFile), false, "dead unit file removed");
    const again = reapOrphans();
    NodeAssert.equal(again.removed.length, 0, "a second reap has nothing left to remove");
  } finally {
    NodeFS.rmSync(liveDir, { recursive: true, force: true });
    NodeFS.rmSync(unitFile, { force: true });
    NodeFS.rmSync(deadDir, { recursive: true, force: true });
    NodeFS.rmSync(deadUnitFile, { force: true });
  }
});

NodeTest.test("a dry run lists orphan fixtures and stray unit files and removes nothing", () => {
  const cache = cacheRoot();
  const config = configUnitDir();
  NodeFS.mkdirSync(cache, { recursive: true });
  NodeFS.mkdirSync(config, { recursive: true });
  const noRecord = NodeFS.mkdtempSync(NodePath.join(cache, "hbots-release-fixture-norecord-"));
  const deadDir = NodeFS.mkdtempSync(NodePath.join(cache, "hbots-release-fixture-drydead-"));
  const deadUnit = `hbots-fixture-${NodePath.basename(deadDir).split("-").pop()}.service`;
  const deadUnitFile = NodePath.join(config, deadUnit);
  NodeFS.writeFileSync(deadUnitFile, "[Unit]\nDescription=dry run\n");
  NodeFS.writeFileSync(
    NodePath.join(deadDir, "fixture.json"),
    JSON.stringify({
      schema: 1,
      unit: deadUnit,
      unitFile: deadUnitFile,
      dir: deadDir,
      port: 0,
      ownerPid: 99999999,
      ownerStart: "1",
      createdAt: new Date().toISOString(),
    }),
  );
  const strayUnit = `hbots-fixture-${unitTag(cache)}-${NodeCrypto.randomBytes(4).toString("hex")}.service`;
  const strayFile = NodePath.join(config, strayUnit);
  NodeFS.writeFileSync(strayFile, "[Unit]\nDescription=stray\n");
  try {
    const r = reapOrphans({ dryRun: true });
    NodeAssert.equal(r.dryRun, true);
    NodeAssert.ok(
      r.orphans.some((o) => o.dir === noRecord && o.reason === "no record"),
      "no-record orphan listed",
    );
    NodeAssert.ok(
      r.orphans.some((o) => o.dir === deadDir && /gone/.test(o.reason)),
      "dead owner orphan listed",
    );
    NodeAssert.ok(
      r.strayUnits.some((s) => s.unit === strayUnit),
      "stray unit listed",
    );
    NodeAssert.equal(NodeFS.existsSync(noRecord), true, "dry run kept the no-record dir");
    NodeAssert.equal(NodeFS.existsSync(deadDir), true, "dry run kept the dead dir");
    NodeAssert.equal(NodeFS.existsSync(deadUnitFile), true, "dry run kept the dead unit");
    NodeAssert.equal(NodeFS.existsSync(strayFile), true, "dry run kept the stray unit");
    NodeAssert.deepEqual(r.removed, [], "dry run removed nothing");
  } finally {
    NodeFS.rmSync(noRecord, { recursive: true, force: true });
    NodeFS.rmSync(deadDir, { recursive: true, force: true });
    NodeFS.rmSync(deadUnitFile, { force: true });
    NodeFS.rmSync(strayFile, { force: true });
  }
});

NodeTest.test("a reaper never removes a live fixture that belongs to another cache", () => {
  const base = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "cross-cache-"));
  const cacheA = NodePath.join(base, "cache-a");
  const cacheB = NodePath.join(base, "cache-b");
  const unitsA = NodePath.join(base, "units-a");
  const unitsB = NodePath.join(base, "units-b");
  for (const dir of [cacheA, cacheB, unitsA, unitsB]) NodeFS.mkdirSync(dir, { recursive: true });
  const owner = { ownerPid: process.pid, ownerStart: procStart(process.pid) };
  const taggedDir = NodePath.join(cacheA, "hbots-release-fixture-keep-TAGA01");
  const legacyDir = NodePath.join(cacheA, "hbots-release-fixture-old-LEGACY");
  const taggedUnit = `hbots-fixture-${unitTag(cacheA)}-TAGA01.service`;
  const legacyUnit = "hbots-fixture-LEGACY.service";
  const taggedFile = NodePath.join(unitsA, taggedUnit);
  const legacyFile = NodePath.join(unitsA, legacyUnit);
  const writeFixture = (dir, unit, unitFile) => {
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(unitFile, "[Unit]\nDescription=live owner fixture\n");
    NodeFS.writeFileSync(
      NodePath.join(dir, "fixture.json"),
      JSON.stringify({
        schema: 1,
        unit,
        unitFile,
        dir,
        port: 0,
        ...owner,
        createdAt: new Date().toISOString(),
      }),
    );
  };
  writeFixture(taggedDir, taggedUnit, taggedFile);
  writeFixture(legacyDir, legacyUnit, legacyFile);
  try {
    const foreign = reapOrphans({ cacheDir: cacheB, unitDirs: [unitsA, unitsB] });
    NodeAssert.deepEqual(foreign.orphans, [], "cache A dirs are not cache B's business");
    NodeAssert.deepEqual(foreign.strayUnits, [], "a live unit from another cache is not a stray");
    NodeAssert.deepEqual(foreign.removed, []);
    NodeAssert.equal(NodeFS.existsSync(taggedFile), true, "cache A tagged unit file intact");
    NodeAssert.equal(NodeFS.existsSync(taggedDir), true, "cache A tagged fixture intact");
    NodeAssert.equal(NodeFS.existsSync(legacyFile), true, "cache A pre-tag unit file intact");
    NodeAssert.equal(NodeFS.existsSync(legacyDir), true, "cache A pre-tag fixture intact");

    const own = reapOrphans({ cacheDir: cacheA, unitDirs: [unitsA] });
    NodeAssert.equal(own.live.length, 2, "the owning cache sees both fixtures live");
    NodeAssert.deepEqual(own.removed, []);

    const strayUnit = `hbots-fixture-${unitTag(cacheB)}-STRAY1.service`;
    const strayFile = NodePath.join(unitsB, strayUnit);
    NodeFS.writeFileSync(strayFile, "[Unit]\nDescription=stray\n");
    const stray = reapOrphans({ cacheDir: cacheB, unitDirs: [unitsA, unitsB] });
    NodeAssert.deepEqual(
      stray.strayUnits.map((s) => s.unit),
      [strayUnit],
      "the cache's own tagged stray is still removed",
    );
    NodeAssert.equal(NodeFS.existsSync(strayFile), false);
    NodeAssert.equal(NodeFS.existsSync(taggedFile), true, "cache A unit still intact");
  } finally {
    NodeFS.rmSync(base, { recursive: true, force: true });
  }
});

NodeTest.test("a record naming another dir's unit is ignored, the dir suffix decides", () => {
  const cache = cacheRoot();
  const config = configUnitDir();
  NodeFS.mkdirSync(cache, { recursive: true });
  NodeFS.mkdirSync(config, { recursive: true });
  const dir = NodeFS.mkdtempSync(NodePath.join(cache, "hbots-release-fixture-mismatch-"));
  const suffix = NodePath.basename(dir).split("-").pop();
  const foreignUnit = `hbots-fixture-${unitTag(NodePath.join(SCRATCH, "other-cache"))}-FOREIGN.service`;
  const foreignFile = NodePath.join(config, foreignUnit);
  NodeFS.writeFileSync(foreignFile, "[Unit]\nDescription=not this dir's unit\n");
  NodeFS.writeFileSync(
    NodePath.join(dir, "fixture.json"),
    JSON.stringify({
      schema: 1,
      unit: foreignUnit,
      unitFile: foreignFile,
      dir,
      port: 0,
      ownerPid: 99999999,
      ownerStart: "1",
      createdAt: new Date().toISOString(),
    }),
  );
  try {
    const r = reapOrphans();
    const orphan = r.orphans.find((o) => o.dir === dir);
    NodeAssert.deepEqual(orphan.units, [
      `hbots-fixture-${unitTag(cache)}-${suffix}.service`,
      `hbots-fixture-${suffix}.service`,
    ]);
    NodeAssert.equal(NodeFS.existsSync(foreignFile), true, "the foreign unit file is untouched");
    NodeAssert.equal(NodeFS.existsSync(dir), false, "the orphan dir is still removed");
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
    NodeFS.rmSync(foreignFile, { force: true });
  }
});

NodeTest.test("a spinning reaper never removes a fixture that is still being created", async () => {
  const report = NodePath.join(
    SCRATCH,
    `race-removed-${process.pid}-${NodeCrypto.randomBytes(3).toString("hex")}.json`,
  );
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const spin = spawn(process.execPath, [REAPER_SPIN_SCRIPT, "4000", report], {
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  spin.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => spin.once("exit", resolve));
  const created = [];
  const errors = [];
  const end = Date.now() + 2500;
  let failure = null;
  try {
    while (Date.now() < end) {
      let env;
      try {
        env = await makeEnv({ name: "race" });
        created.push(env.tmp);
      } catch (e) {
        errors.push(String(e.message));
      } finally {
        if (env) env.stop();
      }
    }
  } catch (e) {
    failure = e;
  }
  await exited;
  if (failure) throw failure;
  NodeAssert.deepEqual(errors, [], `makeEnv errors: ${errors.join("; ")}`);
  NodeAssert.ok(created.length >= 3, `only ${created.length} fixtures made`);
  if (NodeFS.existsSync(report)) {
    const removed = JSON.parse(NodeFS.readFileSync(report, "utf8"));
    NodeAssert.deepEqual(
      removed.filter((p) => created.includes(p)),
      [],
      `the reaper removed in-flight fixtures\n${stderr}`,
    );
    NodeFS.rmSync(report, { force: true });
  } else {
    NodeAssert.fail(`the spinning reaper did not report\n${stderr}`);
  }
});

NodeTest.test("importing the harness outside node --test prints no test summary", () => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const r = sh(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(ROOT, "tests", "env.mjs")).href)})`,
    ],
    { env: childEnv },
  );
  NodeAssert.equal(r.status, 0, r.stderr);
  NodeAssert.doesNotMatch(r.stdout + r.stderr, /tests 0/);
});

NodeTest.test("the fixture harness refuses to load under Vitest", () => {
  const r = sh(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(NodeURL.pathToFileURL(NodePath.join(ROOT, "tests", "env.mjs")).href)})`,
    ],
    { env: { ...process.env, VITEST: "1" } },
  );
  NodeAssert.notEqual(r.status, 0);
  NodeAssert.match(r.stderr, /node --test, not Vitest/);
});

NodeTest.test(
  "big release: stopped-server backup, background check of the copy, retention keeps 3",
  async (t) => {
    const env = await prepared(t, { migrateTo: 114 }, (e) => {
      for (const name of [
        "20260101-000001",
        "20260101-000002",
        "20260101-000003",
        "20260101-000004",
      ]) {
        const d = NodePath.join(e.home, "backups", name);
        NodeFS.mkdirSync(d, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(d, "backup.json"), "{}");
      }
    });
    try {
      const g = env.runner("--guards-only");
      NodeAssert.equal(g.status, 0, g.stdout + g.stderr);
      NodeAssert.match(g.stdout, /Fixture backup proof passed/);
      const r = env.launch(null);
      NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
      const j = await waitResult(env);
      NodeAssert.equal(j.status, "live_verified", j.error);
      NodeAssert.equal(j.backupExit, 0);
      NodeAssert.equal(j.backupVerified, true);
      NodeAssert.equal(j.backupMaxMigration, 113);
      NodeAssert.ok(j.backupPath && NodeFS.existsSync(NodePath.join(j.backupPath, "state.sqlite")));
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(j.backupPath, "backup.json"), "utf8"),
      );
      NodeAssert.equal(manifest.validation.ic, "ok");
      NodeAssert.equal(
        NodeFS.readdirSync(NodePath.join(env.home, "backups")).filter((n) =>
          /^\d{8}-\d{6}$/.test(n),
        ).length,
        3,
      );
      NodeAssert.ok(j.timings["backup.stopped-window"] >= 0);
      NodeAssert.match(NodeFS.readFileSync(env.sheet, "utf8"), /backup .*migration 113 -> 114/);
    } finally {
      env.stop();
    }
  },
);

async function stoppedBackup(databases) {
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-release-dbs-"));
  const stateDir = NodePath.join(tmp, "userdata");
  NodeFS.mkdirSync(stateDir);
  for (const [name, migration] of Object.entries(databases))
    makeFixtureDb(NodePath.join(stateDir, name), migration);
  const cfg = { stateDir, node: process.execPath };
  const dest = NodePath.join(tmp, "backups", "20260101-000000");
  return { tmp, cfg, dest };
}

const sha256 = (file) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

NodeTest.test(
  "stopped copy of a root with state.sqlite and statev2.sqlite copies and checks both",
  async () => {
    const { tmp, cfg, dest } = await stoppedBackup({ "state.sqlite": 113, "statev2.sqlite": 120 });
    try {
      const sizes = liveSizes(cfg);
      NodeAssert.equal(
        sizes.db,
        NodeFS.statSync(NodePath.join(cfg.stateDir, "state.sqlite")).size +
          NodeFS.statSync(NodePath.join(cfg.stateDir, "statev2.sqlite")).size,
      );
      const copied = copyStopped(cfg, dest, { allowSlow: true });
      NodeAssert.deepEqual(
        copied.map((f) => f.name),
        ["state.sqlite", "statev2.sqlite"],
      );
      writeManifest(dest, {
        schema: 1,
        method: "stopped-reflink-copy",
        files: copied,
        validation: null,
      });
      const check = await verifyBackup(cfg, dest, 120);
      NodeAssert.equal(check.mig, 120);
      const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(dest, "backup.json"), "utf8"));
      NodeAssert.deepEqual(Object.keys(manifest.databases), ["state.sqlite", "statev2.sqlite"]);
      NodeAssert.equal(manifest.databases["state.sqlite"].mig, 113);
      NodeAssert.equal(manifest.databases["statev2.sqlite"].mig, 120);
      for (const name of ["state.sqlite", "statev2.sqlite"]) {
        NodeAssert.equal(manifest.databases[name].ic, "ok");
        NodeAssert.equal(manifest.databases[name].sha256, sha256(NodePath.join(dest, name)));
        NodeAssert.equal(
          manifest.databases[name].bytes,
          NodeFS.statSync(NodePath.join(dest, name)).size,
        );
      }
      NodeAssert.equal(manifest.validation.mig, 120);
    } finally {
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

NodeTest.test("stopped copy of a root with only state.sqlite checks it as before", async () => {
  const { tmp, cfg, dest } = await stoppedBackup({ "state.sqlite": 113 });
  try {
    const copied = copyStopped(cfg, dest, { allowSlow: true });
    NodeAssert.deepEqual(
      copied.map((f) => f.name),
      ["state.sqlite"],
    );
    writeManifest(dest, { schema: 1, files: copied, validation: null });
    const check = await verifyBackup(cfg, dest, 113);
    NodeAssert.deepEqual([check.mig, check.rows, check.mem], [113, 25, 7]);
    const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(dest, "backup.json"), "utf8"));
    NodeAssert.deepEqual(Object.keys(manifest.databases), ["state.sqlite"]);
    NodeAssert.equal(manifest.validation.sha256, sha256(NodePath.join(dest, "state.sqlite")));
    await NodeAssert.rejects(verifyBackup(cfg, dest, 120), /migration 113; expected 120/);
  } finally {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }
});

NodeTest.test("stopped copy refuses a root with no database", async () => {
  const { tmp, cfg, dest } = await stoppedBackup({});
  try {
    NodeAssert.throws(() => copyStopped(cfg, dest, { allowSlow: true }), /no database/);
  } finally {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }
});

NodeTest.test("migration mismatch between flags and git source is refused", async (t) => {
  const env = await prepared(t, { migrateTo: 113 });
  try {
    const r = env.runner("--guards-only", ["--migration-after", "114"]);
    NodeAssert.equal(r.status, 1);
    NodeAssert.match(r.stdout + r.stderr, /tops out at 113/);
  } finally {
    env.stop();
  }
});

NodeTest.test(
  "guards refuse: tampered artifact, missing notes, failed evidence, changed helper, wrong baseline, legacy flag in a real run",
  async (t) => {
    const env = await prepared(t);
    try {
      let r = env.runner("--guards-only", ["--rollback", "c".repeat(12)]);
      NodeAssert.equal(r.status, 1, "seal made with another rollback");
      env.flag("notes-fail");
      r = env.runner("--guards-only");
      NodeAssert.equal(r.status, 1);
      NodeAssert.match(r.stdout, /check-release-notes exited 1/);
      NodeFS.rmSync(NodePath.join(env.home, "flags", "notes-fail"));
      env.flag("evidence-fail");
      r = env.runner("--guards-only");
      NodeAssert.equal(r.status, 1);
      NodeAssert.match(r.stdout, /check-gate-evidence exited 1/);
      NodeFS.rmSync(NodePath.join(env.home, "flags", "evidence-fail"));
      r = env.runner(null, ["--legacy-no-evidence"]);
      NodeAssert.equal(r.status, 2);
      NodeAssert.match(r.stderr, /legacy-no-evidence/);
      // a changed pinned tool
      NodeFS.appendFileSync(NodePath.join(env.tools, "ops-common.mjs"), "\n// tampered\n");
      r = env.runner("--guards-only");
      NodeAssert.equal(r.status, 1);
      NodeAssert.match(r.stdout, /differs from the pinned hash/);
      // a changed artifact
      env.writePins();
      NodeFS.appendFileSync(
        NodePath.join(env.home, "releases", env.release, "dist", "bin.mjs"),
        "\n// changed after sealing\n",
      );
      r = env.runner("--guards-only");
      NodeAssert.equal(r.status, 1);
      NodeAssert.match(r.stdout, /not the sealed one/);
      // the live baseline moved
      NodeFS.writeFileSync(
        NodePath.join(env.home, "releases", "current.txt"),
        `${"d".repeat(12)}\n`,
      );
      r = env.runner("--dry-run");
      NodeAssert.equal(r.status, 1);
    } finally {
      env.stop();
    }
  },
);

NodeTest.test(
  "live database is never opened: dbcheck refuses live roots and non-backup folders",
  () => {
    const dbcheck = NodePath.join(ROOT, "lib", "dbcheck.mjs");
    const live = "/home/harout/.personal-bots/dev/userdata/state.sqlite";
    const r = sh(process.execPath, [dbcheck, live]);
    NodeAssert.equal(r.status, 1);
    NodeAssert.match(r.stderr, /refusing to open|under a live data root/);
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-dbcheck-"));
    try {
      const live = NodePath.join(tmp, "userdata");
      NodeFS.mkdirSync(live);
      makeFixtureDb(NodePath.join(live, "statev2.sqlite"), 1);
      NodeFS.writeFileSync(NodePath.join(live, "backup.json"), "{}");
      const v2 = sh(process.execPath, [dbcheck, NodePath.join(live, "statev2.sqlite")]);
      NodeAssert.equal(v2.status, 1);
      NodeAssert.match(v2.stderr, /under a live data root/);
    } finally {
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    }
    for (const file of [
      "idle.mjs",
      "proc.mjs",
      "verify.mjs",
      "guards.mjs",
      "seal.mjs",
      "sheet.mjs",
    ]) {
      const src = NodeFS.readFileSync(NodePath.join(ROOT, "lib", file), "utf8");
      NodeAssert.doesNotMatch(
        src,
        /node:sqlite|DatabaseSync|better-sqlite3/,
        `${file} must not open a database`,
      );
    }
  },
);

NodeTest.test(
  "launcher refuses a second waiter, a wrong baseline and a missing seal",
  async (t) => {
    const env = await makeEnv();
    t.after(() => env.stop());
    try {
      env.start();
      env.target();
      env.writePins();
      let r = env.launch(null);
      NodeAssert.equal(r.status, 1);
      NodeAssert.match(r.stdout, /REFUSED .*No seal/);
      env.runner("--prepare");
      r = env.launch(null, ["--rollback", "e".repeat(12)]);
      NodeAssert.equal(r.status, 1);
      NodeAssert.match(r.stdout, /REFUSED .*expected the baseline/);
    } finally {
      env.stop();
    }
  },
);

NodeTest.test("the runner sits outside the server's cgroup (survives its restart)", async (t) => {
  const env = await prepared(t);
  try {
    env.launch(null);
    const unit = `hbots-release-run-${env.targetVersion}.service`;
    await sleep(500);
    const cg = sh("systemctl", [
      "--user",
      "show",
      unit,
      "-p",
      "ControlGroup",
      "--value",
    ]).stdout.trim();
    NodeAssert.ok(cg === "" || !cg.includes(env.unit), `runner cgroup ${cg}`);
    await waitResult(env);
  } finally {
    env.stop();
  }
});
