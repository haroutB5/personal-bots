// hbots perf: the in-app journeys bench.mjs does not walk (scrolling, Tasks,
// Scheduled, Team, a long chat, send, the panels).
//
//   node scripts/personal/perf/journeys.mjs --origin <url> [--runs 5] [--cpu 4]
//        [--journeys list-scroll,tasks,scheduled,team,chat-long,chat-scroll,send,panel]
//        [--long <chat path>] [--out <file.json>] [--off flag1,flag2] [--ab <flag>]
//   --off  runs with those optimizations off (localStorage "bots:perf-off")
//   --ab   alternates runs with <flag> on and off; journeys are reported as name@on / name@off
//
// Same phone as bench.mjs (390x844 at DPR 3, touch, 4x CPU) and the same probe
// (probe.js). A journey is: reset the probe's marks, do one tap or swipe, wait
// for a mark. Scroll journeys have no mark: they record every animation frame
// while a fixed set of touch swipes runs, and report the frame-time tail and the
// long-task time during the swipes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  chromium,
  resolveOrigin,
  authStatePath,
  median,
  quantile,
  round,
  PERF_HOME,
} from "./lib.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v, i, a) => (v.startsWith("--") ? [v.slice(2), a[i + 1] ?? true] : null))
    .filter(Boolean),
);
const origin = resolveOrigin(args.origin ?? "local");
const runs = Number(args.runs ?? 5);
const cpuRate = Number(args.cpu ?? 4);
const wanted = new Set(
  (args.journeys ?? "list-scroll,tasks,scheduled,team,chat-long,chat-scroll,send,panel").split(","),
);
const offFlags = typeof args.off === "string" ? args.off.split(",").filter(Boolean) : [];
const abFlag = typeof args.ab === "string" ? args.ab : null;
const longChat = typeof args.long === "string" ? args.long : null;
const probeSource = NodeFS.readFileSync(new URL("./probe.js", import.meta.url), "utf8");
const statePath = authStatePath(origin);
if (!NodeFS.existsSync(statePath)) {
  console.error(`No signed-in state for ${origin}. Run login.mjs first.`);
  process.exit(2);
}

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

// Marks for the journeys below, added to the probe's watchers at run time.
const WATCHERS = {
  // Tasks: the heading and the task-list tabs are painted.
  tasksReady: `() => [...document.querySelectorAll('h1')].find((e) => e.textContent.trim() === 'Tasks') && document.querySelector('nav[aria-label="Task lists"]')`,
  // Scheduled: a routine row, or the empty-state sentence.
  scheduledReady: `() => location.search.includes('view=scheduled') && document.querySelector('a[href^="/tasks/routines/"]')`,
  // Team: the per-bot token usage card has loaded (aria-busy flips to false).
  teamReady: `() => document.querySelector('section[data-testid="token-usage"][aria-busy="false"]') && document.querySelector('a[aria-label="Back to Bots"]')`,
  // Computer tab (the browser panel): the view and its activity list are up.
  panelReady: `() => document.querySelector('[aria-label="Computer view"]') && [...document.querySelectorAll('h2')].find((e) => e.textContent.trim() === 'Recent activity')`,
};

async function cdpMetrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return {
    script: m.ScriptDuration * 1000,
    task: m.TaskDuration * 1000,
    layouts: m.LayoutCount,
    styles: m.RecalcStyleCount,
  };
}

async function begin(page, cdp, name, find) {
  if (find) {
    await page.evaluate(
      ({ name, find }) => {
        // eslint-disable-next-line no-eval
        window.__perf.watchers.push([name, (0, eval)(find)]);
      },
      { name, find },
    );
  }
  await page.evaluate(() => window.__perf.reset());
  const t0 = await page.evaluate(() => window.__perf.t0);
  return { t0, m0: await cdpMetrics(cdp) };
}

async function finish(page, cdp, mark, start, settleMs = 1000) {
  await page.waitForFunction((n) => window.__perf.marks[n] !== undefined, mark, {
    timeout: 60_000,
    polling: 50,
  });
  await page.waitForTimeout(settleMs);
  const probe = await page.evaluate(
    ({ mark, t0 }) => {
      const P = window.__perf;
      const at = P.marks[mark];
      const before = (s) => s >= t0 && s <= at;
      const lt = P.longTasks.filter(([s]) => before(s));
      const res = performance
        .getEntriesByType("resource")
        .filter((r) => r.startTime >= t0 && r.responseEnd <= at);
      return {
        wall: at - t0,
        commits: P.commitTimes.filter(before).length,
        longTasks: lt.length,
        longTaskMs: lt.reduce((s, [, d]) => s + d, 0),
        requests: res.length,
        clsAfter: P.shifts
          .filter(([s]) => s > at)
          .reduce((s, [, , v]) => s + (typeof v === "number" ? v : 0), 0),
      };
    },
    { mark, t0: start.t0 },
  );
  const m1 = await cdpMetrics(cdp);
  return {
    ...probe,
    scriptMs: m1.script - start.m0.script,
    taskMs: m1.task - start.m0.task,
    layouts: m1.layouts - start.m0.layouts,
  };
}

/** Touch swipes with a frame recorder: frame-time tail and long tasks during the swipes. */
async function swipes(page, cdp, { x, y, distance, count }) {
  await page.evaluate(() => {
    const F = (window.__fr = { on: true, last: 0, d: [], lt0: window.__perf.longTasks.length });
    const tick = (t) => {
      if (!F.on) return;
      if (F.last) F.d.push(t - F.last);
      F.last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const m0 = await cdpMetrics(cdp);
  const sumScroll = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll("*")].reduce((s, e) => s + (e.scrollTop || 0), 0) +
        (document.scrollingElement?.scrollTop || 0),
    );
  const before = await sumScroll();
  const t0 = Date.now();
  // Real touch events (CDP's synthesizeScrollGesture does not scroll the app's <main>).
  const touch = (type, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  const steps = 20;
  for (let i = 0; i < count; i += 1) {
    await touch("touchStart", y);
    for (let k = 1; k <= steps; k += 1) {
      await touch("touchMove", y + (distance * k) / steps);
      await page.waitForTimeout(16);
    }
    await touch("touchEnd", y + distance);
    await page.waitForTimeout(250);
  }
  const wall = Date.now() - t0;
  await page.waitForTimeout(400);
  const scrolledPx = Math.abs((await sumScroll()) - before);
  const stats = await page.evaluate(() => {
    const F = window.__fr;
    F.on = false;
    const d = [...F.d].sort((a, b) => a - b);
    const q = (p) => d[Math.min(d.length - 1, Math.floor(d.length * p))] ?? 0;
    const lts = window.__perf.longTasks.slice(F.lt0);
    return {
      frames: d.length,
      frameP50: q(0.5),
      frameP95: q(0.95),
      frameMax: d[d.length - 1] ?? 0,
      framesOver50: d.filter((v) => v > 50).length,
      longTasks: lts.length,
      longTaskMs: lts.reduce((s, [, v]) => s + v, 0),
    };
  });
  const m1 = await cdpMetrics(cdp);
  return {
    wall,
    scrolledPx,
    ...stats,
    scriptMs: m1.script - m0.script,
    taskMs: m1.task - m0.task,
    layouts: m1.layouts - m0.layouts,
  };
}

async function oneRun(browser, index, off) {
  const context = await browser.newContext({ ...PHONE, storageState: statePath });
  await context.addInitScript(probeSource);
  await context.addInitScript(
    (value) => localStorage.setItem("bots:perf-off", value),
    ["rum", ...off].join(","),
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const out = { run: index };
  const step = async (name, fn) => {
    if (!wanted.has(name)) return;
    try {
      out[name] = await fn();
    } catch (error) {
      out[name] = { error: String(error?.message ?? error).split("\n")[0] };
      await page
        .screenshot({ path: NodePath.join(PERF_HOME, `fail-journeys-${name}-${index}.png`) })
        .catch(() => {});
    }
  };
  try {
    await page.goto(`${origin}/bots`, { waitUntil: "load", timeout: 90_000 });
    await page.waitForFunction(() => window.__perf?.marks.liveRows !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForTimeout(2500);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });

    await step("list-scroll", async () => {
      const r = await swipes(page, cdp, { x: 195, y: 650, distance: -420, count: 8 });
      await swipes(page, cdp, { x: 195, y: 250, distance: 600, count: 8 });
      return r;
    });
    await step("team", async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      const s = await begin(page, cdp, "teamReady", WATCHERS.teamReady);
      await page.locator('a[aria-label="Team"]').first().tap();
      return finish(page, cdp, "teamReady", s);
    });
    await step("tasks", async () => {
      await page.goto(`${origin}/bots`, { waitUntil: "load", timeout: 90_000 });
      await page.waitForFunction(() => window.__perf?.marks.liveRows !== undefined, null, {
        timeout: 90_000,
      });
      await page.waitForTimeout(1500);
      const s = await begin(page, cdp, "tasksReady", WATCHERS.tasksReady);
      await page.locator('nav a[href="/tasks"]').first().tap();
      return finish(page, cdp, "tasksReady", s);
    });
    await step("scheduled", async () => {
      const s = await begin(page, cdp, "scheduledReady", WATCHERS.scheduledReady);
      await page.locator('nav[aria-label="Task lists"] a[href*="view=scheduled"]').first().tap();
      return finish(page, cdp, "scheduledReady", s);
    });
    await step("panel", async () => {
      await page.goto(`${origin}/bots`, { waitUntil: "load", timeout: 90_000 });
      await page.waitForFunction(() => window.__perf?.marks.liveRows !== undefined, null, {
        timeout: 90_000,
      });
      await page.waitForTimeout(1500);
      const s = await begin(page, cdp, "panelReady", WATCHERS.panelReady);
      await page.locator('nav a[href="/computer"]').first().tap();
      return finish(page, cdp, "panelReady", s);
    });
    if (
      longChat &&
      (wanted.has("chat-long") ||
        wanted.has("chat-scroll") ||
        wanted.has("send") ||
        wanted.has("panel"))
    ) {
      await step("chat-long", async () => {
        const s = await begin(page, cdp, "chat", null);
        await page.goto(`${origin}${longChat}`, { waitUntil: "commit", timeout: 90_000 });
        // goto resets the page: marks restart at t=0 of the new document.
        await page.waitForFunction(() => window.__perf?.marks.chat !== undefined, null, {
          timeout: 90_000,
          polling: 50,
        });
        const r = await page.evaluate(() => ({
          wall: window.__perf.marks.chat,
          commits: window.__perf.commits,
          messages: document.querySelectorAll(
            '[role="log"] [data-message-id], [role="log"] article, [role="log"] > div > div',
          ).length,
          longTaskMs: window.__perf.longTasks
            .filter(([s]) => s <= window.__perf.marks.chat)
            .reduce((a, [, d]) => a + d, 0),
        }));
        await page.waitForTimeout(1500);
        void s;
        return r;
      });
      await step("chat-scroll", async () =>
        swipes(page, cdp, { x: 195, y: 300, distance: 650, count: 10 }),
      );
      await step("send", async () => {
        const token = `PERFSEND${Date.now().toString(36)}`;
        const find = (n) =>
          `() => { const t = document.querySelector('[role="log"]')?.innerText ?? ''; return t.split(${JSON.stringify(token)}).length - 1 >= ${n} ? document.querySelector('[role="log"]') : null; }`;
        const box = page.locator('textarea[placeholder^="Message"]').first();
        await box.tap();
        await page.keyboard.type(token, { delay: 0 });
        await page.evaluate(
          ({ a, b }) => {
            window.__perf.watchers.push(["echo", (0, eval)(a)], ["reply", (0, eval)(b)]);
          },
          { a: find(1), b: find(2) },
        );
        await page.evaluate(() => window.__perf.reset());
        const t0 = await page.evaluate(() => window.__perf.t0);
        const m0 = await cdpMetrics(cdp);
        await page.locator('button[aria-label="Send"]').first().tap();
        const echo = await finish(page, cdp, "echo", { t0, m0 }, 0);
        const reply = await finish(page, cdp, "reply", { t0, m0 }, 800);
        return { ...reply, echoWall: echo.wall, wall: reply.wall };
      });
    }
  } catch (error) {
    out.error = String(error?.message ?? error).split("\n")[0];
    await page
      .screenshot({ path: NodePath.join(PERF_HOME, `fail-journeys-${index}.png`) })
      .catch(() => {});
  } finally {
    await context.close();
  }
  return out;
}

const FIELDS = [
  "wall",
  "scrolledPx",
  "echoWall",
  "frameP50",
  "frameP95",
  "frameMax",
  "framesOver50",
  "frames",
  "commits",
  "longTasks",
  "longTaskMs",
  "scriptMs",
  "taskMs",
  "layouts",
  "requests",
  "clsAfter",
  "messages",
];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
for (let i = 0; i < runs; i += 1) {
  const variant = abFlag === null ? null : i % 2 === 0 ? "on" : "off";
  const raw = await oneRun(browser, i, [...offFlags, ...(variant === "off" ? [abFlag] : [])]);
  const r =
    variant === null
      ? raw
      : Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [
            k === "run" || k === "error" ? k : `${k}@${variant}`,
            v,
          ]),
        );
  results.push(r);
  const line = Object.entries(r)
    .filter(([k]) => k !== "run" && k !== "error")
    .map(
      ([k, v]) => `${k}=${v.error ? "ERR:" + v.error.slice(0, 40) : round(v.wall ?? v.frameP95)}`,
    )
    .join(" ");
  console.log(`run ${i}: ${line}${r.error ? ` ERROR ${r.error}` : ""}`);
}
await browser.close();
const summary = {};
const names = abFlag === null ? [...wanted] : [...wanted].flatMap((n) => [`${n}@on`, `${n}@off`]);
for (const name of names) {
  const rows = results.map((r) => r[name]).filter((v) => v && !v.error);
  summary[name] = { n: rows.length };
  for (const f of FIELDS) {
    const values = rows.map((r) => r[f]).filter((v) => typeof v === "number");
    if (values.length)
      summary[name][f] = { p50: round(median(values), 1), p75: round(quantile(values, 0.75), 1) };
  }
  console.log(
    `${name} (n=${rows.length}, p50/p75): ` +
      FIELDS.filter((f) => summary[name][f])
        .map((f) => `${f}=${summary[name][f].p50}/${summary[name][f].p75}`)
        .join(" "),
  );
}
const outFile = args.out ?? NodePath.join(PERF_HOME, `journeys-${Date.now()}.json`);
NodeFS.writeFileSync(
  outFile,
  JSON.stringify(
    { at: new Date().toISOString(), origin, cpuRate, runs, summary, results },
    null,
    2,
  ),
);
console.log("wrote", outFile);
