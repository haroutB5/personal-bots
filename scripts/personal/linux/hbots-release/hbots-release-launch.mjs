#!/usr/bin/env node
// Launcher for hbots-release.mjs: arms the runner as a detached transient systemd user unit, OUTSIDE hbots.service's
// cgroup, so it survives the server restart it performs. Same options as the runner.
// Pre-checks (cheap): shas, release != rollback, no other waiter, the live release is the rollback baseline,
// seal and tools copy exist. Then it waits for the runner's own guards and prints one verdict line:
//   ARMED   status=...  runner passed its guards and is waiting for idle (exit 0)
//   DONE    status=...  a --prepare / --guards-only / --dry-run finished (exit 0)
//   REFUSED status=...  the runner stopped before the idle wait (exit 1)
import fs from "node:fs";
import { parseArgs } from "node:util";
import { artifactNames, loadConfig, modeOf } from "./lib/config.mjs";
import { OPTIONS, assertParams } from "./lib/options.mjs";
import { readJson, run, sleep } from "./lib/util.mjs";

const ACTIVE = ["waiting_for_idle", "backing_up", "activating", "smoking", "rolling_back", "live_verified"];
const WAITER_STATES = ["starting", "guards", "waiting_for_idle", "backing_up", "activating", "smoking", "rolling_back"];

function unitState(name) {
  const r = run("systemctl", ["--user", "show", name, "-p", "ActiveState", "-p", "MainPID", "--value"], { timeout: 15_000 });
  const [active, pid] = r.out.trim().split("\n");
  return { active: active || "inactive", pid: Number(pid) || 0 };
}

async function main() {
  const { values: a } = parseArgs({ options: { ...OPTIONS, "guard-timeout": { type: "string", default: "240" } }, strict: true });
  const cfg = loadConfig();
  const mode = modeOf(a);
  const names = artifactNames(cfg, a);
  assertParams(a, mode);
  const armed = mode === "run";
  const runner = new URL("./hbots-release.mjs", import.meta.url).pathname;
  if (!fs.existsSync(runner)) throw new Error(`Runner ${runner} missing.`);

  // 1. no other waiter: a run-mode unit of any version, or an old one-off linux-release waiter
  const listed = run("systemctl", ["--user", "list-units", "--all", "--plain", "--no-legend", "hbots-release-run-*"], { timeout: 15_000 }).out;
  const waiters = [];
  for (const line of listed.split("\n")) {
    const m = /^(hbots-release-run-\d+\.\d+\.\d+)\.service\s+\S+\s+(active|activating|deactivating)/.exec(line.trim());
    if (m) waiters.push(m[1]);
  }
  const old = run("pgrep", ["-f", "linux-release-[0-9.]+\\.mjs"], { timeout: 10_000 }).out.trim().split("\n").filter(Boolean);
  if (armed && (waiters.length || old.length)) throw new Error(`Another waiter is running: ${[...waiters, ...old.map((p) => `pid ${p}`)].join(", ")}.`);
  const unit = `hbots-release-${mode}-${a.version}`;
  if (unitState(`${unit}.service`).active === "active") throw new Error(`${unit}.service is already running.`);

  // 2. live is still the rollback baseline
  const cur = fs.readFileSync(cfg.currentTxt, "utf8").trim();
  const okActive = armed || mode === "prepare" ? [a.rollback] : [a.rollback, a.release];
  if (!okActive.includes(cur)) throw new Error(`Active release is ${cur}, expected the baseline ${a.rollback}.`);

  // 3. seal and tools copy exist (the runner verifies every hash itself)
  if (mode !== "prepare") {
    if (!fs.existsSync(names.seal)) throw new Error(`No seal ${names.seal}. Run the runner with --prepare first.`);
    if (!fs.existsSync(`${names.tools}/scripts/personal`)) throw new Error("Tools copy missing. Run the runner with --prepare first.");
  }
  if (armed && fs.existsSync(names.result)) {
    const prev = readJson(names.result);
    if (WAITER_STATES.includes(prev?.status) && prev.runnerPid && fs.existsSync(`/proc/${prev.runnerPid}`)) throw new Error(`A result file for ${a.version} says status ${prev.status} and pid ${prev.runnerPid} is alive. Check before re-arming.`);
  }

  // 4. launch detached
  const launchedAt = Date.now();
  const args = ["--user", `--unit=${unit}`, "--collect", "--quiet", "-p", "CPUAccounting=yes", "-p", "MemoryAccounting=yes", "-p", "Nice=5", "-p", "CPUWeight=20", `--setenv=HBOTS_RELEASE_UNIT=${unit}.service`];
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("HBOTS_RELEASE_TEST")) args.push(`--setenv=${k}=${v}`);
  args.push(cfg.node, runner);
  for (const [k, v] of Object.entries(a)) {
    if (k === "guard-timeout" || v === undefined || v === false) continue;
    if (v === true) args.push(`--${k}`);
    else args.push(`--${k}=${v}`);
  }
  const started = run("systemd-run", args, { timeout: 30_000 });
  if (started.code !== 0) throw new Error(`systemd-run failed: ${(started.err || started.out).slice(0, 300)}`);
  let pid = 0;
  for (let i = 0; i < 20 && !pid; i++) {
    pid = unitState(`${unit}.service`).pid;
    if (!pid) await sleep(100);
  }
  fs.writeFileSync(names.pid, `${pid}\n`);
  console.log(`LAUNCHED unit=${unit}.service PID=${pid} (runner guards running)`);

  // 5. wait for the runner's guards
  const deadline = Date.now() + Number(a["guard-timeout"]) * 1000;
  let status = "";
  while (Date.now() < deadline) {
    await sleep(1000);
    let j = null;
    try {
      if (fs.statSync(names.result).mtimeMs >= launchedAt - 1000) j = readJson(names.result);
    } catch {}
    if (j) {
      status = String(j.status);
      if (j.mode === mode) {
        if (!armed && ["dryrun_ok", "guards_ok", "prepared"].includes(status)) {
          console.log(`DONE status=${status} unit=${unit}.service result=${names.result} (nothing was armed)`);
          return 0;
        }
        if (armed && ACTIVE.includes(status)) {
          console.log(`ARMED status=${status} unit=${unit}.service PID=${pid} result=${names.result}`);
          return 0;
        }
        if (["failed", "rolled_back", "rollback_failed"].includes(status)) {
          console.log(`REFUSED status=${status} error=${j.error}`);
          return 1;
        }
      }
    }
    if (unitState(`${unit}.service`).active === "inactive" && !pid) break;
    if (!fs.existsSync(`/proc/${pid}`)) {
      console.log(`REFUSED runner pid ${pid} exited; last status '${status}'. See ${names.log}.`);
      return 1;
    }
  }
  console.log(`Runner still in guards after ${a["guard-timeout"]} s (status '${status}'); unit ${unit}.service left running.`);
  return 1;
}

main().then(
  (c) => {
    process.exitCode = c;
  },
  (e) => {
    console.log(`REFUSED ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  },
);
