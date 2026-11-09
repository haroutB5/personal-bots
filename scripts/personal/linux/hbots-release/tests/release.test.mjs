// Fixture tests for the Linux release runner. Run: node --NodeTest.test --NodeTest.test-concurrency=1 tests/
// Wrapped by the heavy-job lock: bash dev-team/tools/heavy-job.sh --label hbots-release-tests -- node --NodeTest.test ...
// Each case builds its own throwaway world (tests/env.mjs); nothing touches the live hbots service or data.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { copyStopped, liveSizes, verifyBackup, writeManifest } from "../lib/backup.mjs";
import { makeFixtureDb } from "../lib/fixture.mjs";
import { makeEnv, sh, sleep, ROOT, spawn } from "./env.mjs";

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

async function prepared(opts = {}, setup) {
  const env = await makeEnv(opts);
  env.start();
  env.target(opts.target);
  setup?.(env);
  env.writePins();
  const r = env.runner("--prepare");
  NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
  return env;
}

NodeTest.test("prepare, guards-only and dry-run pass and do not restart the server", async () => {
  const env = await prepared();
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
  async () => {
    const env = await prepared();
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
  async () => {
    const env = await prepared();
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
  async () => {
    const env = await prepared();
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

NodeTest.test("a startup error in the log fails the extended checks and rolls back", async () => {
  const env = await prepared({ target: { badLog: true } });
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

NodeTest.test("rollback that also fails its smoke is reported as rollback_failed", async () => {
  const env = await prepared();
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
  async () => {
    const env = await prepared();
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
  async () => {
    const env = await makeEnv();
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

NodeTest.test("waiting for idle tells Harout on the desktop and in his chat, once", async () => {
  const env = await makeEnv({ constants: { WAITING_ALERT_MINUTES: "0" } });
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
  async () => {
    const env = await prepared();
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

NodeTest.test("the runner waits for both heavy-job slots", async () => {
  const env = await prepared();
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
});

NodeTest.test(
  "big release: stopped-server backup, background check of the copy, retention keeps 3",
  async () => {
    const env = await prepared({ migrateTo: 114 }, (e) => {
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

NodeTest.test("migration mismatch between flags and git source is refused", async () => {
  const env = await prepared({ migrateTo: 113 });
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
  async () => {
    const env = await prepared();
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

NodeTest.test("launcher refuses a second waiter, a wrong baseline and a missing seal", async () => {
  const env = await makeEnv();
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
});

NodeTest.test("the runner sits outside the server's cgroup (survives its restart)", async () => {
  const env = await prepared();
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
