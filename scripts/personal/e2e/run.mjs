// Runs the phone e2e smoke journeys against one throwaway server.
//   node run.mjs --url <http://127.0.0.1:port> --pair <pairing link> --bin <dist\bin.mjs> --out <dir>
//                [--journeys id,id] [--channel chrome|msedge]
//                [--name <throwaway name> --tw <throwaway-server.ps1> --root <its root>]  (journeys that stop and
//                restart the server, e.g. offline-queue, need these three)
// Normally started by scripts\personal\e2e-smoke.ps1, which owns the server (start, stop, root
// deletion). Exit code: 0 all passed, 1 a journey failed, 2 setup failed.
// A journey also fails on any uncaught page error or unhandled rejection that is not on the explicit
// allowlist in page-errors.mjs (empty by default).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { JOURNEYS, SELFTEST_JOURNEYS } from "./journeys.mjs";
import { OFFLINE_JOURNEYS } from "./offlineQueue.mjs";
import { describePageErrors, splitPageErrors } from "./page-errors.mjs";
import {
  JOURNEY_LIMIT_MS,
  loadPlaywright,
  openPhone,
  pairContext,
  stepLogger,
  stopwatch,
} from "./lib.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

const args = parseArgs(process.argv.slice(2));
const origin = args.url?.replace(/\/$/, "");
const outDir = args.out;
if (!origin || !args.pair || !outDir) {
  console.error(
    "usage: run.mjs --url <origin> --pair <pairing link> --out <dir> [--bin <bin.mjs>] [--journeys a,b]",
  );
  process.exit(2);
}
NodeFS.mkdirSync(outDir, { recursive: true });
const wanted = args.journeys
  ? args.journeys
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  : null;
const selected = wanted
  ? [...JOURNEYS, ...OFFLINE_JOURNEYS, ...SELFTEST_JOURNEYS].filter((journey) =>
      wanted.includes(journey.id),
    )
  : JOURNEYS;

/**
 * Takes the throwaway server away and brings it back (same root, same port) for a journey that needs the
 * laptop to disappear. Only the recorded PID is stopped, by throwaway-server.ps1 itself.
 */
function serverControl() {
  if (!args.name || !args.tw) return null;
  const run = (flag) => {
    const result = NodeChildProcess.spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", args.tw, flag, args.name],
      { encoding: "utf8", timeout: 240_000 },
    );
    if (result.status !== 0) {
      throw new Error(
        `throwaway-server.ps1 ${flag} ${args.name} failed (exit ${result.status}): ${(result.stdout + result.stderr).trim().slice(-300)}`,
      );
    }
  };
  return { down: async () => run("-Down"), up: async () => run("-Up") };
}
const server = serverControl();
if (selected.length === 0) {
  console.error(
    `No journey matches ${args.journeys}. Known: ${JOURNEYS.map((j) => j.id).join(", ")}`,
  );
  process.exit(2);
}

const PAGE_ERROR_SETTLE_MS = 300;
const suiteElapsed = stopwatch();
let browser;
const results = [];
try {
  const { chromium } = loadPlaywright(args.bin);
  browser = await chromium.launch({ channel: args.channel ?? "chrome", headless: true });
  // The ps1 kills this pid (and only this one) if the suite hangs past its limit.
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  const pid = processInfo.find((info) => info.type === "browser")?.id;
  if (pid) NodeFS.writeFileSync(NodePath.join(outDir, "browser.pid"), String(pid));
  await cdp.detach().catch(() => undefined);
  const storageState = await pairContext(browser, origin, args.pair);
  console.log(`paired, ${selected.length} journey(s), ${suiteElapsed()} ms in`);

  for (const journey of selected) {
    const elapsed = stopwatch();
    const step = stepLogger(journey.id, elapsed);
    const { context, page, errors } = await openPhone(browser, origin, storageState);
    let failure = null;
    try {
      const limitMs = journey.limitMs ?? JOURNEY_LIMIT_MS;
      await Promise.race([
        journey.run({ page, context, origin, step, server, root: args.root }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`journey exceeded ${limitMs} ms`)), limitMs),
        ),
      ]);
      // Give a background throw or rejection a moment to surface before judging the journey.
      await page.waitForTimeout(PAGE_ERROR_SETTLE_MS);
      const { unexpected } = splitPageErrors(errors);
      if (unexpected.length > 0) throw new Error(describePageErrors(journey.id, unexpected));
    } catch (error) {
      failure = stripAnsi(String(error?.message ?? error));
      await page
        .screenshot({ path: NodePath.join(outDir, `${journey.id}.png`) })
        .catch(() => undefined);
      const text = await page.evaluate(() => document.body.innerText).catch(() => "");
      NodeFS.writeFileSync(
        NodePath.join(outDir, `${journey.id}.txt`),
        `url: ${page.url()}\n\nerror: ${failure}\n\npage errors:\n${errors.join("\n")}\n\nbody text:\n${text}\n`,
      );
    } finally {
      await context.close().catch(() => undefined);
    }
    const ms = elapsed();
    const { unexpected, allowed } = splitPageErrors(errors);
    results.push({
      id: journey.id,
      title: journey.title,
      ok: failure === null,
      ms,
      error: failure,
      pageErrors: errors,
      unexpectedPageErrors: unexpected,
      allowedPageErrors: allowed,
    });
    console.log(
      `${failure === null ? "PASS" : "FAIL"} ${journey.id} (${ms} ms)${failure ? `: ${failure}` : ""}`,
    );
    if (unexpected.length > 0)
      console.log(`     unexpected page errors: ${unexpected.join(" | ")}`);
    if (allowed.length > 0) console.log(`     allowed page errors: ${allowed.join(" | ")}`);
  }
} catch (error) {
  console.error(`setup failed: ${error?.stack ?? error}`);
  await browser?.close().catch(() => undefined);
  NodeFS.writeFileSync(
    NodePath.join(outDir, "result.json"),
    JSON.stringify({ ok: false, setupError: String(error), results }, null, 2),
  );
  process.exit(2);
}
await browser.close().catch(() => undefined);

const failed = results.filter((result) => !result.ok);
const summary = {
  ok: failed.length === 0,
  totalMs: suiteElapsed(),
  passed: results.length - failed.length,
  failed: failed.length,
  results,
};
NodeFS.writeFileSync(NodePath.join(outDir, "result.json"), JSON.stringify(summary, null, 2));
console.log(
  `${summary.ok ? "E2E PASS" : "E2E FAIL"}: ${summary.passed}/${results.length} journeys in ${summary.totalMs} ms`,
);
process.exit(summary.ok ? 0 : 1);
