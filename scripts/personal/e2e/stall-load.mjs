// The scripted load for the 1.66.33 stall checks (driven by ../qa-16633.ps1):
// on a throwaway server, while a disk-load generator runs on the same volume,
// keep pressing the paths whose synchronous work blocked the live event loop:
//   - the Usage strip's "Refresh usage" button: rpc:server.refreshProviders,
//     which resolves every provider CLI against PATH (the 4.4-5.3 s statSync /
//     path.normalize walks of 12 Oct 14:12 and 17:31 live) and probes --version;
//   - a streaming fake bot turn (SLOW<n>): session spawn and the provider
//     event log appends a busy bot produces.
// It writes <out>/stall-load.json with what it did; the stall counts come from
// the server log afterwards (stall-report.mjs).
//
// Usage: node stall-load.mjs --origin <url> --pair <pairing-url> --bin <playwright dir> --out <dir> --seconds <n>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  loadPlaywright,
  newChatOnBotScreen,
  openBots,
  openPhone,
  pairContext,
  send,
} from "./lib.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ["origin", "pair", "bin", "out", "seconds"]) {
  if (!args[key]) throw new Error(`--${key} is required`);
}
const seconds = Number(args.seconds);
NodeFS.mkdirSync(args.out, { recursive: true });

const report = { refreshes: 0, turns: 0, errors: [] };
// Google Chrome, like the e2e smoke: a Playwright WebKit tap here fires no click.
const { chromium } = loadPlaywright(args.bin);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const storageState = await pairContext(browser, args.origin, args.pair);
  const { context, page, errors } = await openPhone(browser, args.origin, storageState);

  // A streaming turn keeps provider events, session spawns and event-log
  // appends flowing while the refreshes run. SLOW<n> is the fake CLI's bare
  // trigger word (it streams for n seconds, then answers).
  await openBots(page, args.origin);
  await newChatOnBotScreen(page, args.origin, "Assistant", "E2E stall load");
  await send(page, "SLOW120");
  report.turns += 1;

  // Back to the Bots page (the turn streams server-side): the Usage strip
  // lives there, and each "Refresh usage" is one rpc:server.refreshProviders
  // - the RPC whose synchronous CLI resolution blocked the live loop.
  await openBots(page, args.origin);
  const strip = page.locator('button[aria-label^="Usage:"]').first();
  await strip.waitFor({ state: "visible", timeout: 30_000 });

  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      await strip.tap();
      const refresh = page.getByRole("button", { name: "Refresh usage" });
      await refresh.waitFor({ state: "visible", timeout: 10_000 });
      await refresh.tap();
      report.refreshes += 1;
      // Let the probe settle a moment before the next one.
      await page.waitForTimeout(1200);
    } catch (error) {
      report.errors.push(String(error).slice(0, 200));
      await page.waitForTimeout(500);
    }
  }
  report.pageErrors = errors;
  await page.screenshot({ path: NodePath.join(args.out, "stall-load.png") }).catch(() => {});
  await context.close();
} finally {
  await browser.close();
}
NodeFS.writeFileSync(NodePath.join(args.out, "stall-load.json"), JSON.stringify(report, null, 2));
console.log(
  `load done: refreshes=${report.refreshes} turns=${report.turns} errors=${report.errors.length}`,
);
