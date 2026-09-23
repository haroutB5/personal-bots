// J4: how smooth is a long streamed reply with code blocks and a table?
//
//   node scripts/personal/perf/stream.mjs [--origin local] [--cpu 4] [--bot "Assistant"] [--off flag]
//
// Opens a NEW chat with the bot, sends a prompt that makes it stream a long
// markdown answer, and measures the streaming window (first reply text ->
// reply finished): long tasks, frame gaps (rAF intervals), React commits and
// layout shifts. Deletes the test chat afterwards. Costs one model turn.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { chromium, resolveOrigin, authStatePath, PERF_HOME, quantile, round } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v, i, a) => (v.startsWith("--") ? [v.slice(2), a[i + 1] ?? true] : null))
    .filter(Boolean),
);
const origin = resolveOrigin(args.origin ?? "local");
const cpu = Number(args.cpu ?? 4);
const botPath = args.botPath ?? "/bots/personal-seed-assistant";
const off = [
  ...(args.rum ? [] : ["rum"]),
  ...(typeof args.off === "string" ? args.off.split(",") : []),
];
const probeSource = NodeFS.readFileSync(new URL("./probe.js", import.meta.url), "utf8");
const PROMPT =
  "Answer without using any tools. Write a markdown reply of about 70 lines: a short intro, " +
  "then three fenced code blocks of about 15 lines each (TypeScript, Python, Bash) with a sentence " +
  "before each, then a markdown table with 6 rows and 4 columns, then a two-line summary.";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  storageState: authStatePath(origin),
});
await context.addInitScript(probeSource);
await context.addInitScript((value) => {
  try {
    localStorage.setItem("bots:perf-off", value);
  } catch {}
}, off.join(","));
await context.addInitScript(() => {
  // Frame timing: every rAF interval, so dropped frames show as long gaps.
  window.__frames = [];
  let last = 0;
  const tick = (at) => {
    if (last) window.__frames.push([at, at - last]);
    last = at;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await page.goto(origin + botPath, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(1500);
await page
  .getByRole("button", { name: /new chat/i })
  .or(page.getByRole("link", { name: /new chat/i }))
  .first()
  .click();
await page.waitForURL(/\/bots\/[^/]+\/[0-9a-f-]{36}/, { timeout: 30000 });
const chatPath = new URL(page.url()).pathname;
await page.waitForSelector('textarea[placeholder^="Message"]', { timeout: 30000 });
await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
if (args.profile) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  await cdp.send("Profiler.start");
}
await page
  .getByPlaceholder(/Message/i)
  .first()
  .fill(PROMPT);
const sendAt = await page.evaluate(() => performance.now());
await page.getByRole("button", { name: "Send" }).first().click();

// Streaming window: first assistant text until the Stop button goes away and
// the reply stops growing.
const lastAssistantLength = () =>
  page.evaluate(() => {
    const log = document.querySelector('[role="log"]');
    return log ? log.textContent.length : 0;
  });
let first = null;
let lastGrowth = null;
let lastLength = await lastAssistantLength();
const baseLength = lastLength;
for (let i = 0; i < 600; i++) {
  await page.waitForTimeout(250);
  const length = await lastAssistantLength();
  const now = await page.evaluate(() => performance.now());
  if (length > lastLength) {
    if (first === null && length > baseLength + PROMPT.length + 20) first = now;
    lastGrowth = now;
  }
  lastLength = length;
  // A plain selector: getByRole polling showed up in the profile itself.
  const stop = await page.locator('button[aria-label="Stop"]').count();
  if (first !== null && stop === 0 && now - lastGrowth > 3000) break;
}
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
if (args.profile) {
  const { profile } = await cdp.send("Profiler.stop");
  const file = NodePath.join(PERF_HOME, `stream-${Date.now()}.cpuprofile`);
  NodeFS.writeFileSync(file, JSON.stringify(profile));
  console.log("cpu profile:", file);
}
const result = await page.evaluate(
  ({ from, to }) => {
    const P = window.__perf;
    const inWindow = (t) => t >= from && t <= to;
    const longTasks = P.longTasks.filter(([s]) => inWindow(s));
    const frames = window.__frames.filter(([t]) => inWindow(t)).map(([, d]) => d);
    const shifts = P.shifts.filter(([s]) => inWindow(s));
    return {
      streamMs: to - from,
      longTasks: longTasks.length,
      longTaskMs: longTasks.reduce((s, [, d]) => s + d, 0),
      maxLongTask: longTasks.reduce((m, [, d]) => Math.max(m, d), 0),
      commits: P.commitTimes.filter(inWindow).length,
      frames: frames.length,
      framesOver50: frames.filter((d) => d > 50).length,
      framesOver100: frames.filter((d) => d > 100).length,
      frameGaps: frames,
      cls: shifts.reduce((s, [, v]) => s + v, 0),
      shiftRegions: shifts
        .map(([t, v, w]) => `${Math.round(t - from)}ms ${v.toFixed(3)} ${w}`)
        .slice(0, 12),
      textLength: document.querySelector('[role="log"]')?.textContent.length ?? 0,
    };
  },
  { from: first ?? sendAt, to: lastGrowth ?? sendAt },
);
result.firstTextMs = first === null ? null : first - sendAt;
result.p95Frame = quantile(result.frameGaps, 0.95);
delete result.frameGaps;
for (const key of Object.keys(result))
  if (typeof result[key] === "number") result[key] = round(result[key], 1);
console.log(JSON.stringify({ off, cpu, ...result }));
NodeFS.writeFileSync(
  NodePath.join(PERF_HOME, `stream-${Date.now()}.json`),
  JSON.stringify({ at: new Date().toISOString(), origin, off, cpu, ...result }, null, 2),
);

// Clean up the test chat.
await page.getByRole("button", { name: "Chat options" }).click();
await page.getByRole("menuitem", { name: "Delete chat" }).click();
const confirm = page.getByRole("button", { name: /^delete/i }).last();
if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) await confirm.click();
await page.waitForTimeout(2000);
console.log("deleted test chat", chatPath, "->", new URL(page.url()).pathname);
await browser.close();
