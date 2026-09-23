// hbots perf bench: phone-sized headless Chrome against the running server.
//
//   node scripts/personal/perf/bench.mjs [--origin local|relay|<url>] [--runs 5]
//        [--journeys J1,J2] [--cpu 4] [--bot "<bot name>"] [--out <file.json>]
//        [--off flag1,flag2] [--ab flag] [--rum]
//
//   --off  turns those optimizations off (localStorage "bots:perf-off", see
//          apps/web/src/features/personal/perfFlags.ts)
//   --ab   alternates runs with <flag> on and off in the same build; the
//          summary splits every journey into name@on / name@off
//   --rum  leaves the app's real-user beacons on (off by default so bench
//          runs do not fill the server log)
//
// Journeys (see README.md):
//   J1-cold   first ever visit to /bots (empty caches) -> chats list usable
//   J1-warm   installed-PWA relaunch of /bots (SW + snapshot warm) -> list usable
//   J2        tap a bot row on the list -> transcript + typeable composer
//   J1-deep   warm relaunch straight into that chat (notification tap) -> chat usable
//
// Every run uses a fresh, isolated browser context (no profile on disk), signed
// in from the cookie file login.mjs saved. CPU is throttled (default 4x) to
// approximate an iPhone; the network is whatever the origin really is.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import {
  chromium,
  resolveOrigin,
  authStatePath,
  median,
  quantile,
  round,
  PERF_HOME,
} from "./lib.mjs";
import * as NodePath from "node:path";

const args = parseArgs(process.argv.slice(2));
const origin = resolveOrigin(args.origin ?? "local");
const runs = Number(args.runs ?? 5);
const cpuRate = Number(args.cpu ?? 4);
const journeys = new Set((args.journeys ?? "J1,J2").split(","));
const botName = args.bot ?? null;
const offFlags = typeof args.off === "string" ? args.off.split(",").filter(Boolean) : [];
const abFlag = typeof args.ab === "string" ? args.ab : null;
const PERF_OFF_KEY = "bots:perf-off";
const probeSource = NodeFS.readFileSync(new URL("./probe.js", import.meta.url), "utf8");
const statePath = authStatePath(origin);
if (!NodeFS.existsSync(statePath)) {
  console.error(`No signed-in state for ${origin}. Run login.mjs with a pairing URL first.`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key.slice(2)] = true;
    else {
      out[key.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

async function machineLoad() {
  const sample = () => NodeOS.cpus().map((c) => c.times);
  const a = sample();
  await new Promise((r) => setTimeout(r, 1000));
  const b = sample();
  let idle = 0;
  let total = 0;
  b.forEach((t, i) => {
    const prev = a[i];
    const d = Object.keys(t).reduce((s, k) => s + (t[k] - prev[k]), 0);
    total += d;
    idle += t.idle - prev.idle;
  });
  return {
    cpuBusyPct: round((1 - idle / total) * 100, 1),
    freeMemGB: round(NodeOS.freemem() / 2 ** 30, 2),
    totalMemGB: round(NodeOS.totalmem() / 2 ** 30, 1),
  };
}

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
};

async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return {
    script: m.ScriptDuration * 1000,
    task: m.TaskDuration * 1000,
    layouts: m.LayoutCount,
    styles: m.RecalcStyleCount,
    heapMB: m.JSHeapUsedSize / 2 ** 20,
  };
}

/** WebSocket traffic per journey, from CDP (the app's data all rides one socket). */
const ws = { framesIn: 0, bytesIn: 0, framesOut: 0, bytesOut: 0 };
function resetWs() {
  ws.framesIn = ws.bytesIn = ws.framesOut = ws.bytesOut = 0;
}
function watchWs(cdp) {
  cdp.on("Network.webSocketFrameReceived", (e) => {
    ws.framesIn += 1;
    ws.bytesIn += e.response?.payloadData?.length ?? 0;
  });
  cdp.on("Network.webSocketFrameSent", (e) => {
    ws.framesOut += 1;
    ws.bytesOut += e.response?.payloadData?.length ?? 0;
  });
}

/** Collect the probe's view of one journey that started at page time `t0`. */
async function collect(page, mark, t0, settleMs = 1500) {
  await page.waitForFunction(
    (name) => window.__perf && window.__perf.marks[name] !== undefined,
    mark,
    {
      timeout: 90_000,
      polling: 50,
    },
  );
  const wsAtMark = {
    wsFramesIn: ws.framesIn,
    wsKBIn: ws.bytesIn / 1024,
    wsFramesOut: ws.framesOut,
  };
  await page.waitForTimeout(settleMs);
  const probe = await page.evaluate(
    ({ mark, t0 }) => {
      const P = window.__perf;
      const at = P.marks[mark];
      const before = (start) => start >= t0 && start <= at;
      const longTasks = P.longTasks.filter(([s]) => before(s));
      const resources = performance
        .getEntriesByType("resource")
        .filter((r) => r.startTime >= t0 && r.responseEnd <= at);
      const scripts = resources.filter(
        (r) => r.initiatorType === "script" || /\.m?js(\?|$)/.test(r.name),
      );
      const shiftsBefore = P.shifts.filter(([s]) => before(s));
      const shiftsAfter = P.shifts.filter(([s]) => s > at);
      const longTasksAfter = P.longTasks.filter(([s]) => s > at);
      const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
      return {
        wall: at - t0,
        fcp: t0 === 0 ? fcp : null,
        splashGone: P.marks.splashGone !== undefined && t0 === 0 ? P.marks.splashGone : null,
        liveRows: P.marks.liveRows !== undefined && t0 === 0 ? P.marks.liveRows : null,
        commits: P.commitTimes.filter((s) => before(s)).length,
        longTasks: longTasks.length,
        longTaskMs: longTasks.reduce((s, [, d]) => s + d, 0),
        requests: resources.length,
        jsKB: scripts.reduce((s, r) => s + (r.decodedBodySize || 0), 0) / 1024,
        jsTransferKB: scripts.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024,
        clsBefore: shiftsBefore.reduce((s, [, v]) => s + v, 0),
        clsAfter: shiftsAfter.reduce((s, [, v]) => s + v, 0),
        shiftRegionsAfter: [...new Set(shiftsAfter.map(([, , w]) => w))].slice(0, 6),
        longTaskMsAfter: longTasksAfter.reduce((s, [, d]) => s + d, 0),
        chatShell: P.marks.chatShell !== undefined ? P.marks.chatShell - t0 : null,
      };
    },
    { mark, t0 },
  );
  return { ...probe, ...wsAtMark };
}

async function measureLoad(page, cdp, url, mark) {
  const m0 = await cdpMetrics(cdp);
  resetWs();
  await page.goto(url, { waitUntil: "commit", timeout: 90_000 });
  const probe = await collect(page, mark, 0);
  const m1 = await cdpMetrics(cdp);
  return withCdp(probe, m0, m1);
}

function withCdp(probe, m0, m1) {
  return {
    ...probe,
    scriptMs: m1.script - m0.script,
    taskMs: m1.task - m0.task,
    layouts: m1.layouts - m0.layouts,
    styleRecalcs: m1.styles - m0.styles,
    heapMB: m1.heapMB,
  };
}

async function waitForServiceWorkerCache(page) {
  // The worker caches /assets/* as the controlled page fetches them. Make sure
  // it controls the page, then give its cache writes a moment.
  await page
    .evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      await navigator.serviceWorker.ready;
      return true;
    })
    .catch(() => false);
}

async function oneRun(browser, index, off) {
  const context = await browser.newContext({ ...PHONE, storageState: statePath });
  await context.addInitScript(probeSource);
  await context.addInitScript(
    ({ key, value }) => {
      try {
        localStorage.setItem(key, value);
      } catch {}
    },
    { key: PERF_OFF_KEY, value: off.join(",") },
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Network.enable");
  watchWs(cdp);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  const out = { run: index };
  try {
    if (journeys.has("J1")) {
      out["J1-cold"] = await measureLoad(page, cdp, `${origin}/bots`, "rows");
      await waitForServiceWorkerCache(page);
      // Prime: first controlled load fills the worker's asset cache.
      await page.goto(`${origin}/bots`, { waitUntil: "load", timeout: 90_000 });
      await page.waitForFunction(() => window.__perf?.marks.rows !== undefined, null, {
        timeout: 90_000,
      });
      await page.waitForTimeout(1500);
      out["J1-warm"] = await measureLoad(page, cdp, `${origin}/bots`, "rows");
    } else {
      await page.goto(`${origin}/bots`, { waitUntil: "load", timeout: 90_000 });
      await page.waitForFunction(() => window.__perf?.marks.rows !== undefined, null, {
        timeout: 90_000,
      });
      await page.waitForTimeout(1500);
    }
    if (journeys.has("J2")) {
      const rowSelector =
        'ul[aria-label="Your chats"] li a[href^="/bots/"]:not([href^="/bots/groups/"])';
      await page.waitForSelector(rowSelector, { timeout: 90_000 });
      const row = botName
        ? page.locator(rowSelector, { hasText: botName }).first()
        : page.locator(rowSelector).first();
      const href = await row.getAttribute("href");
      await page.evaluate(() => window.__perf.reset());
      const t0 = await page.evaluate(() => window.__perf.t0);
      const m0 = await cdpMetrics(cdp);
      resetWs();
      await row.tap();
      const probe = await collect(page, "chat", t0);
      out.J2 = withCdp(probe, m0, await cdpMetrics(cdp));
      out.J2.href = href;
      // Relaunch straight into that chat, as a notification tap does.
      out["J1-deep"] = await measureLoad(page, cdp, `${origin}${href}`, "chat");
    }
  } catch (error) {
    out.error = String(error?.message ?? error).split("\n")[0];
    await page
      .screenshot({ path: NodePath.join(PERF_HOME, `fail-run${index}.png`) })
      .catch(() => {});
  } finally {
    await context.close();
  }
  return out;
}

const FIELDS = [
  "wall",
  "fcp",
  "splashGone",
  "liveRows",
  "chatShell",
  "commits",
  "longTasks",
  "longTaskMs",
  "scriptMs",
  "taskMs",
  "layouts",
  "styleRecalcs",
  "requests",
  "jsKB",
  "jsTransferKB",
  "wsFramesIn",
  "wsKBIn",
  "wsFramesOut",
  "clsBefore",
  "clsAfter",
  "longTaskMsAfter",
  "heapMB",
];

function summarize(results) {
  const names = [
    ...new Set(results.flatMap((r) => Object.keys(r).filter((k) => k.startsWith("J")))),
  ];
  const summary = {};
  for (const name of names) {
    const rows = results.map((r) => r[name]).filter(Boolean);
    summary[name] = { n: rows.length };
    for (const field of FIELDS) {
      const values = rows.map((r) => r[field]).filter((v) => typeof v === "number");
      if (values.length === 0) continue;
      summary[name][field] = {
        p50: round(median(values), field.startsWith("cls") ? 4 : 1),
        p75: round(quantile(values, 0.75), field.startsWith("cls") ? 4 : 1),
      };
    }
  }
  return summary;
}

const load = await machineLoad();
console.log(`origin=${origin} runs=${runs} cpu=${cpuRate}x`, load);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
const version = await fetch(`${origin}/version.txt`)
  .then((r) => r.text())
  .then((t) => t.split("\n").slice(0, 2).join(" "))
  .catch(() => "unknown");
for (let i = 0; i < runs; i += 1) {
  const variant = abFlag === null ? null : i % 2 === 0 ? "on" : "off";
  const off = [...offFlags, ...(args.rum ? [] : ["rum"]), ...(variant === "off" ? [abFlag] : [])];
  const raw = await oneRun(browser, i, off);
  // A/B runs: every journey is filed under name@on / name@off.
  const r =
    variant === null
      ? raw
      : Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [k.startsWith("J") ? `${k}@${variant}` : k, v]),
        );
  results.push(r);
  const line = Object.entries(r)
    .filter(([k]) => k.startsWith("J"))
    .map(([k, v]) => `${k}=${round(v.wall)}ms/${v.commits}c/${v.longTasks}lt`)
    .join(" ");
  console.log(`run ${i}: ${line}${r.error ? ` ERROR ${r.error}` : ""}`);
}
await browser.close();
const summary = summarize(results);
const report = {
  at: new Date().toISOString(),
  origin,
  version,
  cpuRate,
  runs,
  off: offFlags,
  ab: abFlag,
  load,
  summary,
  results,
};
for (const [name, s] of Object.entries(summary)) {
  const cells = FIELDS.filter((f) => s[f]).map((f) => `${f}=${s[f].p50}/${s[f].p75}`);
  console.log(`${name} (n=${s.n}, p50/p75): ${cells.join(" ")}`);
}
const outFile =
  args.out ??
  NodePath.join(PERF_HOME, `bench-${new URL(origin).hostname.split(".")[0]}-${Date.now()}.json`);
NodeFS.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log("wrote", outFile);
