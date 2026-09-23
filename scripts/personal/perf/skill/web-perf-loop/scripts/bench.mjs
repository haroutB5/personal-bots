// Generic phone-sized journey bench (web-perf-loop skill).
//
//   node bench.mjs --config perf.config.json [--runs 7] [--cpu 4] [--out file.json]
//                  [--off flag1,flag2] [--ab flag] [--profile <journey>]
//
// Every run: a fresh isolated Chrome context (no profile on disk), the
// journeys in config order. Journey types:
//   {"name","type":"load","path","until"}             navigate, wait for `until`
//   {"name","type":"tap","tap","until"}               tap a selector, wait for `until`
//   {"name","type":"reload","until"}                  reload the current page
// `until` is a CSS selector that exists (and has a box) only when the journey
// is done. Needs playwright-core resolvable from the current directory (or
// PLAYWRIGHT_CORE=<path>) and a system Chrome.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args[key.slice(2)] = true;
  else {
    args[key.slice(2)] = next;
    i += 1;
  }
}
if (!args.config) {
  console.error("usage: node bench.mjs --config perf.config.json [--runs 7]");
  process.exit(2);
}
const config = JSON.parse(NodeFS.readFileSync(args.config, "utf8"));
const runs = Number(args.runs ?? config.runs ?? 7);
const cpu = Number(args.cpu ?? config.cpuThrottle ?? 4);
const flagsKey = config.flagsKey ?? "perf-off";
const offFlags = typeof args.off === "string" ? args.off.split(",").filter(Boolean) : [];
const abFlag = typeof args.ab === "string" ? args.ab : null;
const profileJourney = typeof args.profile === "string" ? args.profile : null;

function loadPlaywright() {
  const require = NodeModule.createRequire(NodePath.join(process.cwd(), "package.json"));
  const target = process.env.PLAYWRIGHT_CORE ?? "playwright-core";
  try {
    return require(target);
  } catch {
    console.error(
      "playwright-core not found. Run `npm i -D playwright-core` here, or set PLAYWRIGHT_CORE to its path.",
    );
    process.exit(2);
  }
}
const { chromium } = loadPlaywright();
const probeSource = NodeFS.readFileSync(new URL("./probe.js", import.meta.url), "utf8");

const quantile = (values, q) => {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
};
const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

async function machineLoad() {
  const sample = () => NodeOS.cpus().map((c) => c.times);
  const a = sample();
  await new Promise((r) => setTimeout(r, 1000));
  const b = sample();
  let idle = 0;
  let total = 0;
  b.forEach((t, i) => {
    const d = Object.keys(t).reduce((s, k) => s + (t[k] - a[i][k]), 0);
    total += d;
    idle += t.idle - a[i].idle;
  });
  return {
    cpuBusyPct: round((1 - idle / total) * 100),
    freeMemGB: round(NodeOS.freemem() / 2 ** 30, 2),
  };
}

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

async function measure(page, cdp, journey, start) {
  const m0 = await cdpMetrics(cdp);
  const profiling = profileJourney === journey.name;
  if (profiling) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
  }
  const t0 = await start();
  await page.waitForFunction(
    (selector) => window.__perf && window.__perf.marks[selector] !== undefined,
    journey.until,
    { timeout: 90_000, polling: 50 },
  );
  if (profiling) {
    const { profile } = await cdp.send("Profiler.stop");
    const file = `profile-${journey.name}-${Date.now()}.cpuprofile`;
    NodeFS.writeFileSync(file, JSON.stringify(profile));
    console.log("cpu profile:", file, "(open in Chrome DevTools > Performance)");
  }
  await page.waitForTimeout(config.settleMs ?? 2000);
  const m1 = await cdpMetrics(cdp);
  const probe = await page.evaluate(
    ({ selector, t0 }) => {
      const P = window.__perf;
      const at = P.marks[selector];
      const within = (s) => s >= t0 && s <= at;
      const long = P.longTasks.filter(([s]) => within(s));
      const after = P.longTasks.filter(([s]) => s > at);
      const resources = performance
        .getEntriesByType("resource")
        .filter((r) => r.startTime >= t0 && r.responseEnd <= at);
      const scripts = resources.filter(
        (r) => r.initiatorType === "script" || /\.m?js(\?|$)/.test(r.name),
      );
      const shiftsAfter = P.shifts.filter(([s]) => s > at);
      return {
        wall: at - t0,
        commits: P.commitTimes.filter(within).length,
        longTasks: long.length,
        longTaskMs: long.reduce((s, [, d]) => s + d, 0),
        longTaskMsAfter: after.reduce((s, [, d]) => s + d, 0),
        requests: resources.length,
        jsKB: scripts.reduce((s, r) => s + (r.decodedBodySize || 0), 0) / 1024,
        clsBefore: P.shifts.filter(([s]) => within(s)).reduce((s, [, v]) => s + v, 0),
        clsAfter: shiftsAfter.reduce((s, [, v]) => s + v, 0),
        shiftRegionsAfter: [...new Set(shiftsAfter.map(([, , w]) => w))].slice(0, 5),
      };
    },
    { selector: journey.until, t0 },
  );
  return {
    ...probe,
    scriptMs: m1.script - m0.script,
    taskMs: m1.task - m0.task,
    layouts: m1.layouts - m0.layouts,
    styleRecalcs: m1.styles - m0.styles,
    heapMB: m1.heapMB,
  };
}

async function oneRun(browser, off) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    ...config.viewport,
    ...(config.storageState ? { storageState: config.storageState } : {}),
  });
  const selectors = config.journeys.map((j) => j.until);
  await context.addInitScript(`window.__perfSelectors = ${JSON.stringify(selectors)};`);
  await context.addInitScript(probeSource);
  await context.addInitScript(
    ({ key, value }) => {
      try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      } catch {}
    },
    { key: flagsKey, value: off.join(",") },
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  const out = {};
  try {
    for (const journey of config.journeys) {
      if (journey.type === "load") {
        out[journey.name] = await measure(page, cdp, journey, async () => {
          await page.goto(new URL(journey.path, config.baseUrl).href, { waitUntil: "commit" });
          return 0;
        });
      } else if (journey.type === "reload") {
        out[journey.name] = await measure(page, cdp, journey, async () => {
          await page.reload({ waitUntil: "commit" });
          return 0;
        });
      } else if (journey.type === "tap") {
        await page.waitForSelector(journey.tap, { timeout: 60_000 });
        out[journey.name] = await measure(page, cdp, journey, async () => {
          const t0 = await page.evaluate(() => {
            window.__perf.resetMark();
            return performance.now();
          });
          await page.locator(journey.tap).first().tap();
          return t0;
        });
      }
    }
  } catch (error) {
    out.error = String(error?.message ?? error).split("\n")[0];
  } finally {
    await context.close();
  }
  return out;
}

const load = await machineLoad();
console.log(`${config.baseUrl} runs=${runs} cpu=${cpu}x`, load);
const browser = await chromium.launch({
  headless: true,
  ...(config.chromePath ? { executablePath: config.chromePath } : { channel: "chrome" }),
});
const results = [];
for (let i = 0; i < runs; i += 1) {
  const variant = abFlag === null ? null : i % 2 === 0 ? "on" : "off";
  const raw = await oneRun(browser, [...offFlags, ...(variant === "off" ? [abFlag] : [])]);
  const r =
    variant === null
      ? raw
      : Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [k === "error" ? k : `${k}@${variant}`, v]),
        );
  results.push(r);
  console.log(
    `run ${i}: ` +
      Object.entries(r)
        .filter(([k]) => k !== "error")
        .map(([k, v]) => `${k}=${round(v.wall, 0)}ms`)
        .join(" ") +
      (r.error ? ` ERROR ${r.error}` : ""),
  );
}
await browser.close();

const summary = {};
for (const name of new Set(results.flatMap((r) => Object.keys(r).filter((k) => k !== "error")))) {
  const rows = results.map((r) => r[name]).filter(Boolean);
  summary[name] = { n: rows.length };
  for (const field of Object.keys(rows[0] ?? {})) {
    const values = rows.map((r) => r[field]).filter((v) => typeof v === "number");
    if (values.length === 0) continue;
    summary[name][field] = {
      p50: round(quantile(values, 0.5)),
      p75: round(quantile(values, 0.75)),
    };
  }
  const s = summary[name];
  console.log(
    `${name} (n=${s.n}) p50/p75: wall=${s.wall?.p50}/${s.wall?.p75} longTaskMs=${s.longTaskMs?.p50} requests=${s.requests?.p50} jsKB=${s.jsKB?.p50} commits=${s.commits?.p50} clsAfter=${s.clsAfter?.p50}`,
  );
}
const outFile = args.out ?? `bench-${Date.now()}.json`;
NodeFS.writeFileSync(
  outFile,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      baseUrl: config.baseUrl,
      cpu,
      runs,
      off: offFlags,
      ab: abFlag,
      load,
      summary,
      results,
    },
    null,
    2,
  ),
);
console.log("wrote", outFile);
