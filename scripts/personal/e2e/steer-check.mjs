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
// reply is not asserted here; the check waits for the steered turn to END (the
// send button returns to "Send") before it finishes, so the pending-row check
// that runs next really sees the post-turn state (QA 1.66.33 F6, which the
// old script missed because it exited mid-turn). The fork-gate integration
// test (ProjectionPipeline.test.ts, "clears the steered message's pending turn
// start on delivery, in the real order") covers the full event order.
//
// Usage: node steer-check.mjs --origin <url> --pair <pairing-url> --bin <playwright dir> --out <dir> [--chat-state <path>]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { launchBrave } from "./browser.mjs";
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

// Playwright's isVisible() never waits (QA 1.66.33 F6): it answers about the
// page right now, so a check built on it passed or failed on timing luck.
// waitFor({state:"visible"}) is the waiting form; wrap it so a timeout is a
// clean false instead of a throw.
const waitVisible = async (locator, timeoutMs) => {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
};

const playwright = loadPlaywright(args.bin);
const browser = await launchBrave(playwright);
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
  await waitVisible(transcript(page).getByText("Working on the slow job."), 20_000);
  await page.waitForTimeout(1500);
  await composer(page).fill("steer one alpha");
  await page.getByRole("button", { name: /^Send/ }).tap();

  check(
    "the steer bubble is in the running turn's chat",
    await waitVisible(transcript(page).getByText("steer one alpha"), 15_000),
  );
  // "Read" is the delivery receipt: the CLI reported the steer's prompt taken
  // in, which is the exact frame the pending-row fix consumes. Scope it to the
  // steer's own transcript row - an unscoped getByText("Read").first() matches
  // the FIRST message's receipt, which is already "Read" and would pass before
  // the steer is delivered (QA 1.66.33 F6).
  const steerRow = transcript(page).locator("[data-transcript-row]", {
    hasText: "steer one alpha",
  });
  check(
    "the steer is delivered mid-turn (its own Read receipt)",
    await waitVisible(steerRow.getByText("Read", { exact: true }), 25_000),
  );

  // The turn must END before this check finishes: pending-turns-check.mjs runs
  // straight after and can only prove "no pending row after the steered turn"
  // if the steered turn is over (QA 1.66.33 F6). The composer's send button
  // reads exactly "Send" only when no turn is running.
  const turnEnded = await waitVisible(
    page.getByRole("button", { name: "Send", exact: true }),
    45_000,
  );
  check("the steered turn ends (send button idle)", turnEnded);
  if (turnEnded) {
    check(
      "the steer's row keeps its Read receipt after the turn",
      await waitVisible(steerRow.getByText("Read", { exact: true }), 10_000),
    );
  }
  await page.screenshot({ path: NodePath.join(args.out, "steer-check.png") }).catch(() => {});
  check("no uncaught page errors", errors.length === 0, errors.join(" | "));
  NodeFS.writeFileSync(
    NodePath.join(args.out, "steer-check.json"),
    JSON.stringify({ chatId, failures, turnEnded }),
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
