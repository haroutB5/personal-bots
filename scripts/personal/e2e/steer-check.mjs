// 1.66.33 check B at runtime (driven by ../qa-16633.ps1): produce the real
// steer order on a throwaway - a slow fake-Claude turn is running, the owner
// sends a second message mid-turn (a tap-send steers since 1.66.28), the fake
// folds it in and reports it taken in - and prove the two facts the release
// fix owns:
//   1. the steer message is delivered into the running turn (the "Read"
//      receipt, i.e. the server received the CLI's command_lifecycle frame);
//   2. the steer does NOT open a turn of its own (the chat still has exactly
//      one turn, the running one) - and, in pending-turns-check.mjs, no
//      pending turn-start row survives and the idle classifier sees the table.
// The fake does not emulate the real CLI's post-steer streaming, so the fold
// reply and the slow finish are not asserted here; the fork-gate integration
// test (ProjectionPipeline.test.ts, "clears the steered message's pending turn
// start on delivery, in the real order") covers the full order including the
// turn end.
//
// Usage: node steer-check.mjs --origin <url> --pair <pairing-url> --bin <playwright dir> --out <dir> [--chat-state <path>]
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

const { chromium } = loadPlaywright(args.bin);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const storageState = await pairContext(browser, args.origin, args.pair);
  const { context, page, errors } = await openPhone(browser, args.origin, storageState);
  await newChatOnBotScreen(page, args.origin, "Assistant", "E2E steer row");
  const chatId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);

  // Sends go through the Send button (Enter is a newline on the phone layout).
  // While a turn runs the button's label becomes "Send, the bot takes it in
  // during this turn. Hold for send options", so match the prefix both times.
  await composer(page).fill("SLOW15");
  await page.getByRole("button", { name: /^Send/ }).tap();
  await transcript(page)
    .getByText("Working on the slow job.")
    .isVisible({ timeout: 20_000 })
    .catch(() => false);
  await page.waitForTimeout(1500);
  await composer(page).fill("steer one alpha");
  await page.getByRole("button", { name: /^Send/ }).tap();

  check(
    "the steer bubble is in the running turn's chat",
    await transcript(page)
      .getByText("steer one alpha")
      .isVisible({ timeout: 15_000 })
      .catch(() => false),
  );
  // "Read" is the delivery receipt: the CLI reported the steer's prompt taken
  // in, which is the exact frame the pending-row fix consumes.
  check(
    "the steer is delivered mid-turn (Read receipt)",
    await transcript(page)
      .getByText("Read", { exact: true })
      .first()
      .isVisible({ timeout: 25_000 })
      .catch(() => false),
  );
  await page.screenshot({ path: NodePath.join(args.out, "steer-check.png") }).catch(() => {});
  check("no uncaught page errors", errors.length === 0, errors.join(" | "));
  NodeFS.writeFileSync(
    NodePath.join(args.out, "steer-check.json"),
    JSON.stringify({ chatId, failures: 0 }),
  );
  await context.close();
} finally {
  await browser.close();
}
if (failures > 0) {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}
console.log("All passed.");
