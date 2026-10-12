// 1.66.33 check B at runtime (driven by ../qa-16633.ps1): a message steered
// into a running fake-Claude turn must leave no pending turn-start row. The
// fake CLI's SLOW<n> streams for n seconds; the second message sent while it
// runs is folded into the turn (the 1.66.28 steer behaviour), then the turn
// ends. The row check itself is pending-turns-check.mjs against the throwaway
// DB; this script only produces the real event order and reports what it saw.
//
// Usage: node steer-check.mjs --origin <url> --pair <pairing-url> --bin <playwright dir> --out <dir>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  composer,
  loadPlaywright,
  newChatOnBotScreen,
  openPhone,
  pairContext,
  transcript,
} from "./lib.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ["origin", "pair", "bin", "out"]) {
  if (!args[key]) throw new Error(`--${key} is required`);
}
NodeFS.mkdirSync(args.out, { recursive: true });

let failures = 0;
const check = (what, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `\n         ${detail}`}`);
  if (!ok) failures += 1;
};

// Google Chrome, like the e2e smoke: a Playwright WebKit tap here fires no click.
const { chromium } = loadPlaywright(args.bin);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const storageState = await pairContext(browser, args.origin, args.pair);
  const { context, page, errors } = await openPhone(browser, args.origin, storageState);
  await newChatOnBotScreen(page, args.origin, "Assistant", "E2E steer row");

  // The real order: a slow turn starts, the owner's next message is folded
  // into it (a tap-send while working steers since 1.66.28), the turn ends.
  await composer(page).fill("SLOW15");
  await composer(page).press("Enter");
  await page.waitForTimeout(2500);
  await composer(page).fill("steer one alpha");
  await composer(page).press("Enter");
  check(
    "the steer was taken into the running turn",
    await transcript(page)
      .getByText(/Folded in: steer one alpha/)
      .isVisible({ timeout: 20000 })
      .catch(() => false),
  );
  check(
    "the slow turn finished",
    await transcript(page)
      .getByText(/Slow job finished\./)
      .isVisible({ timeout: 30000 })
      .catch(() => false),
  );
  await page.waitForTimeout(1200);
  await page.screenshot({ path: NodePath.join(args.out, "steer-check.png") }).catch(() => {});
  check("no uncaught page errors", errors.length === 0, errors.join(" | "));
  await context.close();
} finally {
  await browser.close();
}
if (failures > 0) {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}
console.log("All passed.");
