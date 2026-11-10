import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  busyReasons,
  classifyOrphan,
  dueWaitingAlerts,
  hasSessionAncestor,
  heavyLockHeld,
  newestEventLog,
  sendWaitingAlerts,
  waitingSummary,
} from "../lib/idle.mjs";
import { cgroupPathFromProcText, onlyInCgroup } from "../lib/proc.mjs";

NodeTest.test("busy tools are only the server cgroup, never a sibling systemd scope", () => {
  // A computer-use Chromium is still a process-tree descendant of the server,
  // but systemd moved it into app-org.chromium.Chromium-*.scope.
  const tree = [700, 701, 702];
  const members = new Map([
    [700, "/user.slice/user-1000.slice/user@1000.service/app.slice/hbots.service"],
    [
      701,
      "/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.chromium.Chromium-123.scope",
    ],
    [
      702,
      "/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.chromium.Chromium-123.scope",
    ],
  ]);
  const server = "/user.slice/user-1000.slice/user@1000.service/app.slice/hbots.service";
  NodeAssert.deepEqual([...onlyInCgroup(tree, members, server)], [700]);
  // Unreadable membership is never guessed into the server's work.
  NodeAssert.deepEqual([...onlyInCgroup(tree, new Map(), server)], []);
  // With no server cgroup to compare against, keep the tree (old behaviour).
  NodeAssert.deepEqual([...onlyInCgroup(tree, members, null)], tree);
  NodeAssert.equal(
    cgroupPathFromProcText(
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/hbots.service\n",
    ),
    "/user.slice/user-1000.slice/user@1000.service/app.slice/hbots.service",
  );
  NodeAssert.equal(cgroupPathFromProcText(""), null);
});

NodeTest.test(
  "orphan is reported and only ignored after ten minutes; pid reuse and a bot turn remain blocking",
  () => {
    const seen = new Map();
    const proc = { pid: 123, ppid: 900, startTicks: 33 };
    const systemd = { cmdline: "/usr/lib/systemd/systemd --user" };
    const age = 31 * 60_000;
    NodeAssert.deepEqual(classifyOrphan(proc, systemd, age, 0, seen), {
      orphan: true,
      ignored: false,
    });
    NodeAssert.equal(classifyOrphan(proc, systemd, age, 599_999, seen).ignored, false);
    NodeAssert.equal(classifyOrphan(proc, systemd, age, 600_000, seen).ignored, true);
    const orphanLook = {
      toolProcs: [
        { pid: 123, cmd: "opencode serve --service", ageSec: 1860, orphan: true, ignored: false },
      ],
      cpu: 0,
      eventsAgeMs: 999999,
      heavy: { held: false },
    };
    const cfg = { cpuBudgetS: 1, eventsQuietMs: 1000 };
    NodeAssert.match(busyReasons(orphanLook, cfg)[0], /pid=123.*orphan-tool/);
    orphanLook.toolProcs[0].ignored = true;
    NodeAssert.deepEqual(busyReasons(orphanLook, cfg), []);
    NodeAssert.equal(
      classifyOrphan({ ...proc, startTicks: 34 }, systemd, age, 600_000, seen).ignored,
      false,
    );
    const turn = { pid: 124, ppid: 125, startTicks: 5 };
    NodeAssert.equal(
      classifyOrphan(turn, { cmdline: "opencode acp" }, age, 2_000_000, seen).orphan,
      false,
    );
    NodeAssert.equal(
      hasSessionAncestor(turn, new Map([[125, { ppid: 1, cmdline: "opencode acp" }]])),
      true,
    );
    const look = {
      toolProcs: [{ pid: 124, cmd: "node task", ageSec: 2000, ignored: false }],
      cpu: 0,
      eventsAgeMs: 999999,
      heavy: { held: false },
    };
    NodeAssert.match(busyReasons(look, { cpuBudgetS: 1, eventsQuietMs: 1000 })[0], /pid=124/);
    look.toolProcs[0].ignored = true;
    NodeAssert.deepEqual(busyReasons(look, { cpuBudgetS: 1, eventsQuietMs: 1000 }), []);
    look.eventsAgeMs = 1;
    NodeAssert.match(busyReasons(look, { cpuBudgetS: 1, eventsQuietMs: 1000 })[0], /events/);
  },
);

NodeTest.test("the notify thread events log never holds the idle gate", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-events-"));
  const notify = "events.11111111-1111-1111-1111-111111111111.log";
  try {
    fs.writeFileSync(path.join(dir, notify), "fresh");
    fs.writeFileSync(path.join(dir, "events.other.log"), "older");
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(path.join(dir, "events.other.log"), past, past);
    NodeAssert.equal(newestEventLog(dir).name, notify);
    NodeAssert.equal(newestEventLog(dir, notify).name, "events.other.log");
    fs.rmSync(path.join(dir, "events.other.log"));
    NodeAssert.deepEqual(newestEventLog(dir, notify), { newest: 0, name: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

NodeTest.test("waiting alerts are due once at 20 and once at 60 minutes", () => {
  const sent = new Set();
  NodeAssert.deepEqual(dueWaitingAlerts(1_199_999, sent), []);
  NodeAssert.deepEqual(dueWaitingAlerts(1_200_000, sent), [20]);
  sent.add(20);
  NodeAssert.deepEqual(dueWaitingAlerts(3_599_999, sent), []);
  NodeAssert.deepEqual(dueWaitingAlerts(3_600_000, sent), [60]);
  sent.add(60);
  NodeAssert.deepEqual(dueWaitingAlerts(9_000_000, sent), []);
});

NodeTest.test("waiting notifications include blockers and are sent once at each threshold", () => {
  const seen = new Set();
  const sent = [];
  const notices = [];
  const send = (text) => {
    sent.push(text);
    return 0;
  };
  const deliver = (alert) => {
    notices.push(alert);
    return `/tmp/${alert.minutes}.json`;
  };
  for (const t of [1_199_999, 1_200_000, 1_300_000, 3_600_000, 3_700_000])
    sendWaitingAlerts({
      elapsedMs: t,
      alerted: seen,
      version: "9.9.9",
      summary: "node pid 123, 245s",
      send,
      deliver,
    });
  NodeAssert.equal(sent.length, 2);
  NodeAssert.equal(sent[0], "hbots 9.9.9 release is waiting (20 min): node pid 123, 245s");
  NodeAssert.deepEqual(
    notices.map((n) => [n.minutes, n.text]),
    [
      [20, "hbots release 9.9.9 waiting on: node pid 123, 245s"],
      [60, "hbots release 9.9.9 waiting on: node pid 123, 245s"],
    ],
  );
});

NodeTest.test("a failed desktop toast is recorded but the chat notice is still delivered", () => {
  const seen = new Set();
  const delivered = [];
  const [alert] = sendWaitingAlerts({
    elapsedMs: 0,
    minutes: [0],
    alerted: seen,
    version: "9.9.9",
    summary: "sleep pid 5, 30s",
    send: () => ({ exit: 127, error: "notify-send: not found" }),
    deliver: (a) => {
      delivered.push(a);
      return "/tmp/notice.json";
    },
  });
  NodeAssert.equal(alert.exit, 127);
  NodeAssert.equal(alert.error, "notify-send: not found");
  NodeAssert.equal(alert.noticeFile, "/tmp/notice.json");
  NodeAssert.equal(delivered.length, 1);
  NodeAssert.equal(delivered[0].minutes, 0);
  NodeAssert.equal(seen.has(0), true);
});

NodeTest.test("waiting summary names one blocker briefly and keeps the full list", () => {
  const { short, full } = waitingSummary([
    { pid: 12, cmd: "/usr/lib/chromium/chromium --type=gpu-process", ageSec: 300, ignored: false },
    { pid: 13, cmd: "python3 watch.py", ageSec: 20, ignored: false },
    { pid: 14, cmd: "old thing", ageSec: 900, ignored: true },
  ]);
  NodeAssert.equal(short, "2 blockers, e.g. chromium pid 12, 300s");
  NodeAssert.match(
    full,
    /\/usr\/lib\/chromium\/chromium --type=gpu-process pid 12, 300s; python3 watch\.py pid 13, 20s/,
  );
  NodeAssert.doesNotMatch(full, /old thing/);
});

NodeTest.test("desk panel displays the current waiting blocker", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-panel-fixture-"));
  fs.mkdirSync(path.join(root, "run"));
  fs.writeFileSync(
    path.join(root, "run/restart-9.9.9-result.json"),
    JSON.stringify({
      status: "waiting_for_idle",
      version: "9.9.9",
      blockers: [{ pid: 123, cmd: "/usr/bin/node task", ageSec: 245, ignored: false }],
    }),
  );
  const result = spawnSync("bash", [new URL("../hbots-desk-status", import.meta.url).pathname], {
    encoding: "utf8",
    env: { ...process.env, HBOTS_STATUS_ROOT: root, HBOTS_STATUS_ONCE: "1" },
  });
  NodeAssert.equal(result.status, 0, result.stderr);
  NodeAssert.match(result.stdout, /waiting on: node pid 123, 245s/);
});

NodeTest.test("desk panel shows both running heavy jobs and the 5-bot cap", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawn, spawnSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-panel-heavy-"));
  fs.mkdirSync(path.join(root, "run"));
  for (const [slot, label] of [
    [1, "frontend build"],
    [2, "qa e2e"],
  ]) {
    fs.writeFileSync(
      path.join(root, `run/omarchy-heavy-${slot}.lock`),
      `pid=${slot} started=${new Date().toISOString()} label=${label} cwd=/x slot=${slot}.lock\n`,
    );
  }
  const holders = [1, 2].map((slot) =>
    spawn("flock", ["-x", path.join(root, `run/omarchy-heavy-${slot}.lock`), "sleep", "8"], {
      stdio: "ignore",
    }),
  );
  await new Promise((r) => setTimeout(r, 400));
  try {
    const result = spawnSync("bash", [new URL("../hbots-desk-status", import.meta.url).pathname], {
      encoding: "utf8",
      env: { ...process.env, HBOTS_STATUS_ROOT: root, HBOTS_STATUS_ONCE: "1" },
    });
    NodeAssert.equal(result.status, 0, result.stderr);
    NodeAssert.match(result.stdout, /limit 5 \(build\)/);
    NodeAssert.match(result.stdout, /frontend build/);
    NodeAssert.match(result.stdout, /qa e2e/);
    NodeAssert.match(result.stdout, /job1/);
    NodeAssert.match(result.stdout, /job2/);
  } finally {
    for (const holder of holders) holder.kill("SIGTERM");
  }
});

NodeTest.test("a gate label names a blocker only while its pid lives", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawn, spawnSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-heavy-label-"));
  const gate = path.join(root, "omarchy-heavy.lock");
  const dead = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });
  const deadPid = dead.pid;
  await new Promise((resolve) => dead.once("exit", resolve));
  // The last runner left its label behind; a normal job now holds the gate shared.
  fs.writeFileSync(
    gate,
    `pid=${deadPid} started=2026-11-10T00:00:00Z label=hbots-release 1.67.1 cwd=/x\n`,
  );
  const shared = spawn("flock", ["-s", gate, "sleep", "15"], { stdio: "ignore" });
  try {
    const heldBySomeoneElse = () =>
      spawnSync("flock", ["-n", "-E", "75", gate, "true"]).status !== 0;
    for (let i = 0; i < 100 && !heldBySomeoneElse(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    NodeAssert.ok(heldBySomeoneElse(), "the fixture holds the gate");
    // A dead pid is not a blocker: the 1.67.2 waiter named the stale 1.67.1 release.
    NodeAssert.deepEqual(heavyLockHeld(gate), { held: true, holder: null });
    // A live holder's own label is still named.
    fs.writeFileSync(
      gate,
      `pid=${shared.pid} started=2026-11-10T00:00:00Z label=release-cleanup tests cwd=/x\n`,
    );
    const live = heavyLockHeld(gate);
    NodeAssert.equal(live.held, true);
    NodeAssert.match(live.holder ?? "", /label=release-cleanup tests/);
  } finally {
    shared.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
