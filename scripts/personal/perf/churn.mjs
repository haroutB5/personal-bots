// hbots perf: what the phone and the server pay while bots are working.
//
//   node scripts/personal/perf/churn.mjs --origin <url> [--seconds 25] [--cpu 4]
//        [--streams 5] [--chat] [--off flag1,flag2] [--server-pid <pid>] [--out file.json]
//
// A throwaway server with the fake Claude CLI only (the fake's "STREAM" prompt
// writes text deltas for 90 s): this starts `--streams` of those turns on
// different bots. A phone-sized, CPU-throttled page (390x844 at DPR 3, 4x) sits
// on the Bots list (or, with --chat, on the first streaming bot's chat) and
// records, for the window: long tasks, React commits, animation-frame gaps,
// RPC calls and WebSocket KB. The probe's per-frame watchers are cleared before
// the window starts, so only the app's own work is measured.
// The server side is a request ping every 50 ms (an event-loop lag proxy) and,
// with --server-pid, the server process's CPU and RSS over the window.
//
// Start each measurement on a fresh server (the 90 s turns of an earlier run
// would still be streaming), alternate A and B, and compare medians; flags
// work like bench.mjs --off (same localStorage key).
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { chromium, resolveOrigin, authStatePath, quantile, round } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v, i, a) =>
      v.startsWith("--")
        ? [v.slice(2), a[i + 1]?.startsWith("--") ? true : (a[i + 1] ?? true)]
        : null,
    )
    .filter(Boolean),
);
const origin = resolveOrigin(args.origin ?? "local");
const seconds = Number(args.seconds ?? 25);
const cpuRate = Number(args.cpu ?? 4);
const streams = Number(args.streams ?? 5);
const off = ["rum", ...(typeof args.off === "string" ? args.off.split(",").filter(Boolean) : [])];
const serverPid = typeof args["server-pid"] === "string" ? args["server-pid"] : null;
const probeSource = NodeFS.readFileSync(new URL("./probe.js", import.meta.url), "utf8");
if (!NodeFS.existsSync(authStatePath(origin))) {
  console.error(`No signed-in state for ${origin}. Run login.mjs first.`);
  process.exit(2);
}

function sampleProcess(pid) {
  if (pid === null) return null;
  const [cpuSec, rssMB] = NodeChildProcess.execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `$p=Get-Process -Id ${pid}; "$($p.CPU) $($p.WorkingSet64/1MB)"`],
    { encoding: "utf8" },
  )
    .trim()
    .split(" ")
    .map(Number);
  return { cpuSec, rssMB, at: Date.now() };
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
// The load generator: an unthrottled page that dispatches the streaming turns.
const generator = await browser.newContext({ storageState: authStatePath(origin) });
const generatorPage = await generator.newPage();
await generatorPage.goto(`${origin}/bots`);
await generatorPage.waitForTimeout(3000);
const rpc = (tag, payload) =>
  generatorPage.evaluate(
    ({ tag, payload }) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws");
        ws.onopen = () =>
          ws.send(JSON.stringify({ _tag: "Request", id: "7", tag, payload, headers: [] }));
        ws.onmessage = (e) => {
          for (const x of [JSON.parse(e.data)].flat()) {
            if (x._tag !== "Exit") continue;
            ws.close();
            if (x.exit?._tag === "Success") resolve(x.exit.value);
            else reject(new Error(JSON.stringify(x.exit).slice(0, 200)));
          }
        };
        setTimeout(() => reject(new Error("RPC timeout " + tag)), 30_000);
      }),
    { tag, payload },
  );
const list = await rpc("personalBots.list", {});
const firstOpenThreadByBot = new Map();
for (const thread of list.threads) {
  if (!thread.archivedAt && !firstOpenThreadByBot.has(thread.botId)) {
    firstOpenThreadByBot.set(thread.botId, thread.threadId);
  }
}
const targets = [...firstOpenThreadByBot].slice(0, streams);
if (targets.length === 0) throw new Error("no open chat to stream into");

// The observer: phone-sized, throttled, on the screen under test.
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  storageState: authStatePath(origin),
});
await phone.addInitScript(probeSource);
await phone.addInitScript((value) => localStorage.setItem("bots:perf-off", value), off.join(","));
const page = await phone.newPage();
const cdp = await phone.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Performance.enable");
const path = args.chat ? `/bots/${targets[0][0]}/${targets[0][1]}` : "/bots";
await page.goto(`${origin}${path}`);
if (args.chat) await page.waitForSelector("textarea", { timeout: 60_000 });
else
  await page.waitForFunction(() => window.__perf?.marks.liveRows !== undefined, null, {
    timeout: 90_000,
  });
await page.waitForTimeout(3000);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });

const calls = new Map();
let wsKBIn = 0;
let wsFramesIn = 0;
cdp.on("Network.webSocketFrameSent", (e) => {
  try {
    for (const x of [JSON.parse(e.response.payloadData)].flat()) {
      if (x._tag === "Request") calls.set(x.tag, (calls.get(x.tag) ?? 0) + 1);
    }
  } catch {}
});
cdp.on("Network.webSocketFrameReceived", (e) => {
  wsFramesIn += 1;
  wsKBIn += e.response.payloadData.length / 1024;
});
await page.evaluate(() => {
  const P = window.__perf;
  P.reset();
  // The probe's own per-frame lookups must not be in the window.
  P.watchers.length = 0;
  const F = (window.__frames = { gaps: [], last: 0, on: true });
  const tick = (t) => {
    if (!F.on) return;
    if (F.last) F.gaps.push(t - F.last);
    F.last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const metric = async () =>
  Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
  );
const m0 = await metric();

const pings = [];
let pinging = true;
const pinger = (async () => {
  while (pinging) {
    const t = performance.now();
    try {
      await fetch(`${origin}/.well-known/t3/environment`, { signal: AbortSignal.timeout(5000) });
      pings.push(performance.now() - t);
    } catch {
      pings.push(5000);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
})();

const server0 = sampleProcess(serverPid);
for (const [, threadId] of targets) {
  await rpc("orchestration.dispatchCommand", {
    type: "thread.turn.start",
    commandId: NodeCrypto.randomUUID(),
    threadId,
    message: {
      messageId: NodeCrypto.randomUUID(),
      role: "user",
      text: "STREAM please",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
}
await page.waitForTimeout(seconds * 1000);
const server1 = sampleProcess(serverPid);
pinging = false;
await pinger;

const m1 = await metric();
const frames = await page.evaluate(() => {
  window.__frames.on = false;
  return window.__frames.gaps;
});
const probe = await page.evaluate(() => ({
  commits: window.__perf.commits,
  longTasks: window.__perf.longTasks.length,
  longTaskMs: window.__perf.longTasks.reduce((s, [, d]) => s + d, 0),
}));
const report = {
  origin,
  seconds,
  cpuRate,
  streams: targets.length,
  screen: args.chat ? "chat" : "list",
  off,
  ...probe,
  taskMsPerSec: round(((m1.TaskDuration - m0.TaskDuration) * 1000) / seconds, 0),
  scriptMsPerSec: round(((m1.ScriptDuration - m0.ScriptDuration) * 1000) / seconds, 0),
  frames: {
    n: frames.length,
    p50: round(quantile(frames, 0.5), 1),
    p95: round(quantile(frames, 0.95), 1),
    over100: frames.filter((g) => g > 100).length,
  },
  rpc: Object.fromEntries([...calls].sort((a, b) => b[1] - a[1]).slice(0, 8)),
  wsKBIn: round(wsKBIn, 0),
  wsFramesIn,
  serverPing: {
    n: pings.length,
    p50: round(quantile(pings, 0.5), 1),
    p95: round(quantile(pings, 0.95), 1),
    max: round(Math.max(...pings), 0),
  },
  server:
    server0 && server1
      ? {
          cpuPct: round(
            ((server1.cpuSec - server0.cpuSec) / ((server1.at - server0.at) / 1000)) * 100,
            0,
          ),
          rssMB0: round(server0.rssMB, 0),
          rssMB1: round(server1.rssMB, 0),
        }
      : null,
};
console.log(JSON.stringify(report));
if (typeof args.out === "string") NodeFS.writeFileSync(args.out, JSON.stringify(report, null, 2));
await browser.close();
