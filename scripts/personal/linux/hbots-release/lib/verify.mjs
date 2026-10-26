// Post-activation verification. Smoke (stability window) runs as a child while checks A run here; checks B
// (log scans) run after smoke. No check reads the live database: migration evidence comes from the startup log.
import fs from "node:fs";
import path from "node:path";
import { readJson, runAsync, sleep, round1, errMsg } from "./util.mjs";
import { cgroupOfPid, descendants, listenerPids, liveState, niceOfPid, procSnapshot } from "./proc.mjs";
import { smokeCli } from "./guards.mjs";

export function serverPort(cfg) {
  const rt = readJson(path.join(cfg.stateDir, "server-runtime.json"));
  const fromOrigin = /:(\d+)\/?$/.exec(String(rt?.origin ?? ""))?.[1];
  return Number(rt?.port ?? fromOrigin ?? cfg.port);
}

async function http(url, { method = "GET", timeoutMs = 15_000 } = {}) {
  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: null, body: "", error: errMsg(error) };
  }
}

export async function waitAlive(cfg, release, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = liveState(cfg);
    if (state && String(state.release) === release) return state;
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
}

export function readLogFrom(file, offset) {
  const stat = fs.statSync(file);
  if (stat.size < offset) throw new Error("Server log shrank during activation; cannot verify startup errors.");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.toString("utf8").split("\n");
  } finally {
    fs.closeSync(fd);
  }
}

/** A: everything that does not need the whole stability window. */
export async function checksA(cfg, a, ctx, result, note) {
  const port = serverPort(cfg);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + cfg.startTimeoutMs;
  let ready = false;
  do {
    const st = readJson(cfg.serverJson);
    if (String(st?.release) === a.release && (await http(`${base}/version.txt`)).status === 200) {
      ready = true;
      break;
    }
    await sleep(500);
  } while (Date.now() < deadline);
  if (!ready) throw new Error(`Server did not serve ${a.release} on ${port} within ${Math.round(cfg.startTimeoutMs / 1000)} s.`);
  let cur = "";
  try {
    cur = fs.readFileSync(cfg.currentTxt, "utf8").trim();
  } catch {}
  const after = readJson(cfg.serverJson);
  const ver = (await http(`${base}/version.txt`)).body;
  result.liveVersion = /^version=(.+)$/m.exec(ver)?.[1]?.trim() ?? null;
  if (cur !== a.release || String(after?.release) !== a.release || result.liveVersion !== ctx.expVersion || /^release=(.+)$/m.exec(ver)?.[1]?.trim() !== a.release) {
    throw new Error(`Current/server/version.txt disagree with the ${ctx.expVersion}/${a.release} target.`);
  }
  const listeners = listenerPids(port);
  if (listeners.length !== 1) throw new Error(`Expected one loopback listener on ${port}; found ${listeners.length}.`);
  const snap = procSnapshot();
  const serverPid = Number(after.pid);
  if (listeners[0] !== serverPid && !descendants(snap, serverPid).has(listeners[0]) && !descendants(snap, listeners[0]).has(serverPid)) {
    throw new Error(`Listener pid ${listeners[0]} is not the tracked server ${serverPid}.`);
  }
  result.serverPid = serverPid;
  result.serverCgroup = cgroupOfPid(serverPid);
  result.serverNice = niceOfPid(serverPid);
  if (!cfg.test && !String(result.serverCgroup ?? "").includes(cfg.unit)) throw new Error(`Server pid ${serverPid} is not inside ${cfg.unit}'s cgroup (${result.serverCgroup}).`);
  note(`Server identity PASS: listener 127.0.0.1:${port} pid ${listeners[0]}, tracked ${serverPid}, cgroup ${result.serverCgroup}, nice ${result.serverNice}, release ${after.release}.`);
  if (a["sw-revision"]) {
    const sw = (await http(`${base}/sw.js`)).body;
    if (!sw.includes(a["sw-revision"])) throw new Error(`Live service worker lacks the ${a["sw-revision"]} revision.`);
  }
  const sent = await http(`${base}/api/personal/push/sent`, { method: "POST" });
  result.sentUnauthenticatedStatus = sent.status;
  if (sent.status !== 401) throw new Error(`Unauthenticated POST /api/personal/push/sent returned ${sent.status}; expected 401.`);
  note("Unauthenticated POST /api/personal/push/sent returned 401.");
  // key files: counts only (no content is read beyond the 6-byte magic)
  let sealed = 0;
  let unsealed = 0;
  const dir = path.join(cfg.stateDir, "secrets");
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^personal-secret-.*\.bin$/.test(name)) continue;
    const fd = fs.openSync(path.join(dir, name), "r");
    try {
      const head = Buffer.alloc(6);
      const n = fs.readSync(fd, head, 0, 6, 0);
      if (n === 6 && head.toString("latin1") === "T3SEC1") sealed++;
      else unsealed++;
    } finally {
      fs.closeSync(fd);
    }
  }
  result.secretKeyFilesSealed = sealed;
  result.secretKeyFilesNotSealed = unsealed;
  note(`Saved key files: ${sealed} sealed, ${unsealed} not sealed (counts only).`);
}

/** B: needs the finished window: the startup log since the restart. */
export function checksB(cfg, a, ctx, result, note, { skipStartupMarker = false } = {}) {
  const lines = readLogFrom(ctx.serverLog, ctx.logByte);
  const text = lines.join("\n");
  const tok = lines.filter((l) => /Token:|Pairing URL/.test(l));
  result.tokenOrPairingLines = tok.length;
  if (tok.length) throw new Error(`Server log since restart has ${tok.length} Token:/Pairing URL lines.`);
  const sched = lines.filter((l) => /Personal schedulers are OFF/.test(l));
  result.schedulersOffLines = sched.length;
  if (sched.length) throw new Error("Server started with T3CODE_PERSONAL_SCHEDULERS=off (Personal schedulers are OFF WARN after restart); the live server must never run with it.");
  if (!skipStartupMarker) {
    if (!/stall recorder on[\s\S]{0,200}profiler:\s*'continuous'/.test(text)) throw new Error("Stall recorder continuous-profiler startup marker absent.");
    result.stallRecorderOn = true;
  }
  if (/stall watchdog error|profiler.{0,60}(?:error|failed)|(?:error|failed).{0,60}profiler/i.test(text)) throw new Error("Watchdog/profiler error in startup log.");
  result.sqliteBusyLines = lines.filter((l) => /SQLITE_BUSY|database is locked/.test(l)).length;
  result.shadowedLines = lines.filter((l) => /CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/.test(l)).length;
  result.relayLines = lines.filter((l) => /relay|tunnel/i.test(l)).length;
  const errors = lines.filter((l) => !/^\s*'sql \d+ ms /.test(l)).filter((l) => /\bERROR\b|\bFATAL\b|MigrationError|SqlError|SQLITE_ERROR|Defect in/.test(l));
  result.logErrors = errors.length;
  result.logWarnings = lines.filter((l) => /\bWARN\b|Warning:/.test(l)).length;
  if (errors.length) throw new Error(`Startup log has ${errors.length} error lines (first: ${errors[0].trim().slice(0, 160)}); review ${ctx.serverLog} from byte ${ctx.logByte}.`);
  if (result.shadowedLines) throw new Error("CLAUDE_SDK_CAN_USE_TOOL_SHADOWED after restart.");
  // migration evidence from the log, since the database itself is never opened by this runner
  const changed = Number(a["migration-after"]) !== Number(a["migration-before"]);
  const ran = /Migrations ran successfully/.test(text);
  const ids = [...text.matchAll(/migrations:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'(\d+)_/g)].map((x) => Number(x[1])));
  result.migrationsRanInLog = ids;
  if (changed) {
    if (!ran || !ids.length || Math.max(...ids) !== Number(a["migration-after"])) throw new Error(`Startup log does not show migrations reaching ${a["migration-after"]} (ran=${ran}, ids=${ids.join(",") || "none"}).`);
    note(`Migration evidence: log shows migrations up to ${Math.max(...ids)}.`);
  } else if (ids.length) {
    note(`Note: startup log ran migration(s) ${ids.join(",")} although the level was unchanged.`);
  }
  note(`Log checks pass: no Token/Pairing lines, schedulers on, ${errors.length} errors, ${result.logWarnings} warnings.`);
}

/** Smoke as a child (stability window) with A inside it, then B. Returns { smokeExit, error }. */
export async function postActivation(cfg, a, names, ctx, stableSec, result, timings, note) {
  const smoke = {
    args: [smokeCli(cfg, names), "smoke", "--root", "dev", "--expect-release", a.release, "--log-from-byte", String(ctx.logByte), "--log-file", ctx.serverLog, "--start-timeout", String(Math.round(cfg.startTimeoutMs / 1000)), "--stable-seconds", String(stableSec)],
  };
  const smokeRun = runAsync(cfg.node, smoke.args, { timeoutMs: 20 * 60_000, env: { ...process.env, HOME: cfg.test ? path.dirname(cfg.home) : process.env.HOME } });
  let aError = null;
  const t0 = Date.now();
  if (ctx.restartExit === 0) {
    try {
      await checksA(cfg, a, ctx, result, note);
    } catch (error) {
      aError = errMsg(error);
    }
  } else aError = `Restart exit ${ctx.restartExit}`;
  timings["post.checks-A-during-smoke"] = round1((Date.now() - t0) / 1000);
  const t1 = Date.now();
  const smokeResult = await smokeRun;
  timings["post.smoke-remaining-wait"] = round1((Date.now() - t1) / 1000);
  for (const line of `${smokeResult.out}\n${smokeResult.err}`.trim().split("\n")) note(`smoke ${line}`);
  const out = { smokeExit: smokeResult.code, error: null, smokeText: smokeResult.out };
  if (smokeResult.code === 0) {
    if (aError) {
      out.smokeExit = 1;
      out.error = aError;
    } else {
      try {
        const t2 = Date.now();
        checksB(cfg, a, ctx, result, note, { skipStartupMarker: ctx.skipStartupMarker });
        timings["post.checks-B"] = round1((Date.now() - t2) / 1000);
      } catch (error) {
        out.smokeExit = 1;
        out.error = errMsg(error);
      }
    }
    if (out.smokeExit !== 0) note(`Extended smoke FAIL: ${out.error}`);
  } else {
    out.error = smokeResult.out.split("\n").filter((l) => /^\s*FAIL\s|Smoke FAILED/.test(l)).slice(0, 2).join(" | ").trim() || `smoke exit ${smokeResult.code}`;
  }
  return out;
}
