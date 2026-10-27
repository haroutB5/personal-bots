// Fixture tests for the Linux release runner. Run: node --test --test-concurrency=1 tests/
// Wrapped by the heavy-job lock: bash dev-team/tools/heavy-job.sh --label hbots-release-tests -- node --test ...
// Each case builds its own throwaway world (tests/env.mjs); nothing touches the live hbots service or data.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeEnv, sh, sleep, ROOT, spawn } from "./env.mjs";

const TERMINAL = ["live_verified", "live_verified_doc_update_failed", "rolled_back", "rollback_failed", "failed"];

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

async function prepared(opts = {}, setup) {
  const env = await makeEnv(opts);
  env.start();
  env.target(opts.target);
  setup?.(env);
  env.writePins();
  const r = env.runner("--prepare");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return env;
}

test("prepare, guards-only and dry-run pass and do not restart the server", async () => {
  const env = await prepared();
  try {
    const pid = env.serverJson().pid;
    let r = env.runner("--guards-only");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(env.result("--guards-only").status, "guards_ok");
    r = env.runner("--dry-run");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = env.result("--dry-run");
    assert.equal(j.status, "dryrun_ok");
    assert.ok(j.plan.rows.length >= 5 && j.plan.low > 0, "dry run prints a timed plan");
    assert.match(r.stdout, /EXPECTED arm -> verified/);
    assert.equal(env.serverJson().pid, pid, "server was not restarted");
    assert.equal(fs.readFileSync(path.join(env.home, "releases", "current.txt"), "utf8").trim(), env.rollback);
    // the seal and the tools copy are the Linux equivalents of the Windows -Prepare output
    assert.ok(fs.existsSync(path.join(env.home, "run", `hbots-${env.targetVersion}-seal.json`)));
    assert.ok(fs.existsSync(path.join(env.home, "run", `release-tools-${env.targetVersion}`, "scripts", "personal", "node", "hbots.mjs")));
  } finally {
    env.stop();
  }
});

test("dry-run --verify-live checks a release that is already live, read-only", async () => {
  const env = await prepared();
  try {
    // make the target the live release the way a finished run would have
    fs.writeFileSync(path.join(env.home, "releases", "current.txt"), `${env.release}\n`);
    sh("systemctl", ["--user", "restart", env.unit]);
    await sleep(1500);
    const pid = env.serverJson().pid;
    const r = env.runner("--dry-run", ["--verify-live"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Smoke PASSED|smoke .*PASSED/);
    assert.equal(env.serverJson().pid, pid, "verify-live must not restart");
  } finally {
    env.stop();
  }
});

test("full cycle through the launcher: ARMED, detached runner survives the restart, result JSON, notice, sheet", async () => {
  const env = await prepared();
  try {
    const before = env.serverJson().pid;
    const r = env.launch(null);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ARMED status=/m);
    const j = await waitResult(env);
    assert.equal(j.status, "live_verified", j.error);
    assert.equal(j.verifiedAt != null && j.activatedAt != null && j.idleAt != null, true);
    assert.equal(j.restartExit, 0);
    assert.equal(j.smokeExit, 0);
    assert.equal(j.liveVersion, env.targetVersion);
    assert.equal(j.backupSkipped, true);
    assert.ok(j.timings.armToVerified > 0 && j.timings.restartToVerified > 0);
    assert.ok(j.selfStats.peakRssMb > 0 && j.selfStats.cpuSeconds >= 0);
    assert.notEqual(env.serverJson().pid, before);
    assert.equal(env.serverJson().release, env.release);
    assert.equal(fs.readFileSync(path.join(env.home, "releases", "current.txt"), "utf8").trim(), env.release);
    assert.ok(fs.existsSync(path.join(env.home, "dev", "runtime", "desktop-update-restart")), "tunnel marker written");
    const notes = env.notices();
    assert.equal(notes.length, 1);
    assert.equal(notes[0][notes[0].indexOf("--outcome") + 1], "live");
    assert.equal(notes[0][notes[0].indexOf("--thread-id") + 1], env.thread);
    assert.match(fs.readFileSync(env.sheet, "utf8"), new RegExp(`\\*\\*v${env.targetVersion.replace(/\./g, "\\.")}\\*\\* live since`));
    assert.match(fs.readFileSync(env.history, "utf8"), new RegExp(`\\*\\*v${env.baselineVersion.replace(/\./g, "\\.")}\\*\\*`));
    // the heavy-job lock is free again
    assert.equal(sh("flock", ["-n", path.join(env.tmp, "heavy.lock"), "true"]).status, 0);
    // a leftover waiter unit must not remain
    const units = sh("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", `hbots-release-run-${env.targetVersion}*`]).stdout.trim();
    assert.equal(units, "");
  } finally {
    env.stop();
  }
});

test("forced smoke failure rolls the binary back, restarts the old release, sends a rolled_back notice", async () => {
  const env = await prepared();
  try {
    env.flag(`fail-smoke-${env.release}`);
    const r = env.launch(null);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = await waitResult(env);
    assert.equal(j.status, "rolled_back", j.error);
    assert.equal(j.rollbackExit, 0);
    assert.equal(j.rollbackSmokeExit, 0);
    assert.equal(env.serverJson().release, env.rollback);
    assert.equal(fs.readFileSync(path.join(env.home, "releases", "current.txt"), "utf8").trim(), env.rollback);
    const n = env.notices()[0];
    assert.equal(n[n.indexOf("--outcome") + 1], "rolled_back");
    assert.equal(n[n.indexOf("--rollback-release") + 1], env.rollback);
    assert.match(fs.readFileSync(env.sheet, "utf8"), new RegExp(`\\*\\*v${env.baselineVersion.replace(/\./g, "\\.")}\\*\\*`), "sheet unchanged");
  } finally {
    env.stop();
  }
});

test("a startup error in the log fails the extended checks and rolls back", async () => {
  const env = await prepared({ target: { badLog: true } });
  try {
    const r = env.launch(null);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = await waitResult(env);
    assert.equal(j.status, "rolled_back");
    assert.match(j.error, /error lines/);
  } finally {
    env.stop();
  }
});

test("rollback that also fails its smoke is reported as rollback_failed", async () => {
  const env = await prepared();
  try {
    env.flag(`fail-smoke-${env.release}`);
    env.flag(`fail-smoke-${env.rollback}`);
    env.launch(null);
    const j = await waitResult(env);
    assert.equal(j.status, "rollback_failed");
    const n = env.notices()[0];
    assert.equal(n[n.indexOf("--outcome") + 1], "rollback_failed");
  } finally {
    env.stop();
  }
});

test("idle wait: recent event-log activity delays the restart; no restart while busy", async () => {
  const env = await prepared();
  try {
    const events = path.join(env.home, "dev", "userdata", "logs", "provider", "events.thread.log");
    const pid = env.serverJson().pid;
    let busy = true;
    const toucher = (async () => {
      while (busy) {
        fs.writeFileSync(events, `${Date.now()}\n`);
        await sleep(300);
      }
    })();
    const t0 = Date.now();
    const r = env.launch(null);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    await sleep(6000);
    assert.equal(env.serverJson().pid, pid, "still on the old server while events are fresh");
    assert.equal(env.result().status, "waiting_for_idle");
    busy = false;
    await toucher;
    const j = await waitResult(env);
    assert.equal(j.status, "live_verified", j.error);
    assert.ok(j.idleLooks.some((l) => l.busyReason?.includes("events=")), "busy looks are recorded");
    assert.ok(Date.parse(j.activatedAt) - t0 > 6000);
  } finally {
    env.stop();
  }
});

test("busy tools: only the server's cgroup counts, never a sibling Chromium scope", async () => {
  const env = await makeEnv();
  const scope = `chromium-fixture-${env.port}`;
  let scoped;
  try {
    // one process inside the unit's cgroup (the server's child), one outside in its own scope
    env.start({ child: "sleep 301" });
    scoped = spawn("systemd-run", ["--user", "--scope", "--quiet", "--collect", `--unit=${scope}`, "--", "sleep", "302"], { stdio: "ignore" });
    await sleep(1500);
    const { loadConfig } = await import("../lib/config.mjs");
    const { takeLook } = await import("../lib/idle.mjs");
    const look = takeLook(loadConfig(env.processEnv()), null);
    assert.equal(look.serverRunning, true);
    assert.match(look.cgDir, new RegExp(env.unit.replaceAll(".", "\\.")));
    const cmds = look.toolProcs.map((p) => p.cmd).join("\n");
    assert.match(cmds, /sleep 301/, "a process in hbots.service's cgroup is hbots work");
    assert.doesNotMatch(cmds, /sleep 302/, "a process in its own scope is not hbots work");
  } finally {
    scoped?.kill("SIGTERM");
    sh("systemctl", ["--user", "stop", `${scope}.scope`]);
    env.stop();
  }
});

test("waiting for idle tells Harout on the desktop and in his chat, once", async () => {
  const env = await makeEnv({ constants: { WAITING_ALERT_MINUTES: "0" } });
  const bin = path.join(env.tmp, "fakebin");
  const notifyLog = path.join(env.tmp, "notify.log");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "notify-send"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${notifyLog}'\n`,
    { mode: 0o755 },
  );
  try {
    env.start({ child: "sleep 302" });
    env.target();
    env.writePins();
    // Inside the detached unit PATH is systemd's, not this test's: point the
    // runner's notifier at the recorder explicitly.
    env.overrides.HBOTS_RELEASE_TEST_NOTIFY_SEND = path.join(bin, "notify-send");
    const prep = env.runner("--prepare");
    assert.equal(prep.status, 0, prep.stdout + prep.stderr);
    const launched = env.launch(null);
    assert.equal(launched.status, 0, launched.stdout + launched.stderr);
    const inbox = path.join(env.home, "dev", "personal", "release-notices");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(fs.existsSync(inbox) && fs.readdirSync(inbox).length > 0)) {
      await sleep(200);
    }
    const notices = fs.readdirSync(inbox).filter((name) => name.endsWith(".json"));
    assert.equal(notices.length, 1, `one waiting notice: ${notices.join(", ")}`);
    const notice = JSON.parse(fs.readFileSync(path.join(inbox, notices[0]), "utf8"));
    assert.equal(notice.outcome, "waiting");
    assert.equal(notice.threadId, env.thread);
    assert.match(notice.detail, /sleep 302/);
    assert.match(notice.logPath, /restart-9\.9\.1\.log$/);
    // The desktop toast is critical (a normal one expires in seconds) and short.
    const toast = fs.readFileSync(notifyLog, "utf8");
    assert.match(toast, /--urgency=critical/);
    assert.match(toast, /--app-name=hbots release/);
    assert.match(toast, /hbots 9\.9\.1 release is waiting \(0 min\): /);
    assert.doesNotMatch(toast, /; .*; .*; /, "the toast names one blocker, not a pid dump");
    const result = env.result();
    assert.equal(result.waitingAlert.minutes, 0);
    assert.match(result.waitingAlert.noticeFile, /-waiting-\d+-0\.json$/);
    // A second look must not deliver it again.
    await sleep(1_600);
    assert.equal(fs.readdirSync(inbox).filter((name) => name.endsWith(".json")).length, 1);
    // Let the wait finish: kill only the child this test started.
    const childPid = Number(fs.readFileSync(path.join(env.home, "run", "fixture-child.pid"), "utf8"));
    process.kill(childPid, "SIGTERM");
    const j = await waitResult(env);
    assert.equal(j.status, "live_verified", j.error);
  } finally {
    env.stop();
  }
});

test("heavy-job lock: waits while another job holds it, never restarts mid-build", async () => {  const env = await prepared();
  try {
    const lock = path.join(env.tmp, "heavy.lock");
    fs.writeFileSync(lock, "pid=0 label=fixture-build\n");
    const holder = spawn("flock", ["-n", lock, "sleep", "8"], { stdio: "ignore" }); // a process this test started
    await sleep(500);
    const pid = env.serverJson().pid;
    const t0 = Date.now();
    env.launch(null);
    await sleep(5000);
    assert.equal(env.serverJson().pid, pid, "no restart while the lock is held");
    assert.match(JSON.stringify(env.result().idleLooks ?? []), /heavy-lock/);
    holder.kill("SIGTERM");
    const j = await waitResult(env);
    assert.equal(j.status, "live_verified", j.error);
    assert.ok(Date.parse(j.activatedAt) - t0 > 5000, "activated only after the lock was freed");
  } finally {
    env.stop();
  }
});

test("the runner waits for both heavy-job slots", async () => {
  const env = await prepared();
  const heavy = path.join(ROOT, "..", "dev-team-tools", "heavy-job.sh");
  const base = path.join(env.tmp, "heavy");
  const jobEnv = {
    ...process.env,
    HEAVY_JOB_BASE: base,
    HEAVY_JOB_MEMORY_HIGH: "off",
    HEAVY_JOB_MIN_FREE_GB: "0",
    HEAVY_JOB_SLOTS: "2",
  };
  const start = (label) =>
    new Promise((resolve) => {
      const p = spawn("bash", [heavy, "--label", label, "--", "sleep", "12"], { stdio: ["ignore", "ignore", "pipe"], env: jobEnv });
      p.stderr.on("data", (d) => {
        if (/nice 10/.test(String(d))) resolve(p);
      });
    });
  const a = await start("slot alpha");
  const b = await start("slot beta");
  try {
    const pid = env.serverJson().pid;
    const r = env.launch(null);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    await sleep(4000);
    assert.equal(env.serverJson().pid, pid, "no restart while both slots run");
    const waiting = env.result();
    assert.equal(waiting.status, "waiting_for_idle");
    assert.match(JSON.stringify(waiting.idleLooks ?? []), /heavy-lock/);
    assert.match(JSON.stringify(waiting.blockers ?? []), /slot (alpha|beta)/);
    assert.match(JSON.stringify(waiting.blockers ?? []), /slot alpha[\s\S]*slot beta|slot beta[\s\S]*slot alpha/);
  } finally {
    a.kill("SIGTERM");
    b.kill("SIGTERM");
  }
  const j = await waitResult(env);
  assert.equal(j.status, "live_verified", j.error);
});

test("big release: stopped-server backup, background check of the copy, retention keeps 3", async () => {
  const env = await prepared({ migrateTo: 114 }, (e) => {
    for (const name of ["20260101-000001", "20260101-000002", "20260101-000003", "20260101-000004"]) {
      const d = path.join(e.home, "backups", name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "backup.json"), "{}");
    }
  });
  try {
    const g = env.runner("--guards-only");
    assert.equal(g.status, 0, g.stdout + g.stderr);
    assert.match(g.stdout, /Fixture backup proof passed/);
    const r = env.launch(null);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = await waitResult(env);
    assert.equal(j.status, "live_verified", j.error);
    assert.equal(j.backupExit, 0);
    assert.equal(j.backupVerified, true);
    assert.equal(j.backupMaxMigration, 113);
    assert.ok(j.backupPath && fs.existsSync(path.join(j.backupPath, "state.sqlite")));
    const manifest = JSON.parse(fs.readFileSync(path.join(j.backupPath, "backup.json"), "utf8"));
    assert.equal(manifest.validation.ic, "ok");
    assert.equal(fs.readdirSync(path.join(env.home, "backups")).filter((n) => /^\d{8}-\d{6}$/.test(n)).length, 3);
    assert.ok(j.timings["backup.stopped-window"] >= 0);
    assert.match(fs.readFileSync(env.sheet, "utf8"), /backup .*migration 113 -> 114/);
  } finally {
    env.stop();
  }
});

test("migration mismatch between flags and git source is refused", async () => {
  const env = await prepared({ migrateTo: 113 });
  try {
    const r = env.runner("--guards-only", ["--migration-after", "114"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /tops out at 113/);
  } finally {
    env.stop();
  }
});

test("guards refuse: tampered artifact, missing notes, failed evidence, changed helper, wrong baseline, legacy flag in a real run", async () => {
  const env = await prepared();
  try {
    let r = env.runner("--guards-only", ["--rollback", "c".repeat(12)]);
    assert.equal(r.status, 1, "seal made with another rollback");
    env.flag("notes-fail");
    r = env.runner("--guards-only");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /check-release-notes exited 1/);
    fs.rmSync(path.join(env.home, "flags", "notes-fail"));
    env.flag("evidence-fail");
    r = env.runner("--guards-only");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /check-gate-evidence exited 1/);
    fs.rmSync(path.join(env.home, "flags", "evidence-fail"));
    r = env.runner(null, ["--legacy-no-evidence"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /legacy-no-evidence/);
    // a changed pinned tool
    fs.appendFileSync(path.join(env.tools, "ops-common.mjs"), "\n// tampered\n");
    r = env.runner("--guards-only");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /differs from the pinned hash/);
    // a changed artifact
    env.writePins();
    fs.appendFileSync(path.join(env.home, "releases", env.release, "dist", "bin.mjs"), "\n// changed after sealing\n");
    r = env.runner("--guards-only");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /not the sealed one/);
    // the live baseline moved
    fs.writeFileSync(path.join(env.home, "releases", "current.txt"), `${"d".repeat(12)}\n`);
    r = env.runner("--dry-run");
    assert.equal(r.status, 1);
  } finally {
    env.stop();
  }
});

test("live database is never opened: dbcheck refuses live roots and non-backup folders", () => {
  const dbcheck = path.join(ROOT, "lib", "dbcheck.mjs");
  const live = "/home/harout/.personal-bots/dev/userdata/state.sqlite";
  const r = sh(process.execPath, [dbcheck, live]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to open|under a live data root/);
  for (const file of ["idle.mjs", "proc.mjs", "verify.mjs", "guards.mjs", "seal.mjs", "sheet.mjs"]) {
    const src = fs.readFileSync(path.join(ROOT, "lib", file), "utf8");
    assert.doesNotMatch(src, /node:sqlite|DatabaseSync|better-sqlite3/, `${file} must not open a database`);
  }
});

test("launcher refuses a second waiter, a wrong baseline and a missing seal", async () => {
  const env = await makeEnv();
  try {
    env.start();
    env.target();
    env.writePins();
    let r = env.launch(null);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /REFUSED .*No seal/);
    env.runner("--prepare");
    r = env.launch(null, ["--rollback", "e".repeat(12)]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /REFUSED .*expected the baseline/);
  } finally {
    env.stop();
  }
});

test("the runner sits outside the server's cgroup (survives its restart)", async () => {
  const env = await prepared();
  try {
    env.launch(null);
    const unit = `hbots-release-run-${env.targetVersion}.service`;
    await sleep(500);
    const cg = sh("systemctl", ["--user", "show", unit, "-p", "ControlGroup", "--value"]).stdout.trim();
    assert.ok(cg === "" || !cg.includes(env.unit), `runner cgroup ${cg}`);
    await waitResult(env);
  } finally {
    env.stop();
  }
});
