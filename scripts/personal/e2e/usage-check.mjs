// Scripted 390 px dark check of the Usage sheet on a throwaway server (1.66.1). Driven by usage-check.ps1,
// which starts the server, flips the fake Claude CLI's flags (testing/fake-claude/cli.js) between phases and
// restarts the server in the middle. One phase per run:
//   seed     both providers read fine: the strip and the sheet show Session and Weekly with "Updated".
//   refresh  the probe is slow (the fake's version-hang): the sheet keeps every number and shows "Refreshing".
//   failed   the probe cannot read usage: the numbers stay, with "Couldn't refresh" and their age.
//   restart  right after a server restart whose first probe also fails: the numbers are still there.
// Exits non-zero on the first failed expectation. Screenshots go to --out.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { loadPlaywright, openPhone, openBots, pairContext } from "./lib.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
for (const key of ["origin", "bin", "out", "phase"]) {
  if (!args[key]) throw new Error(`--${key} is required`);
}
NodeFS.mkdirSync(args.out, { recursive: true });
const stateFile = NodePath.join(args.out, "storage-state.json");

let failures = 0;
const check = (what, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `\n         ${detail}`}`);
  if (!ok) failures += 1;
};

const { chromium } = loadPlaywright(args.bin);
const browser = await chromium.launch({ channel: args.channel ?? "chrome", headless: true });
try {
  let storageState;
  if (args.phase === "seed") {
    if (!args.pair) throw new Error("--pair is required for the seed phase");
    storageState = await pairContext(browser, args.origin, args.pair);
    NodeFS.writeFileSync(stateFile, JSON.stringify(storageState));
  } else {
    storageState = JSON.parse(NodeFS.readFileSync(stateFile, "utf8"));
  }
  const { context, page, errors } = await openPhone(browser, args.origin, storageState);
  await openBots(page, args.origin);

  const stripButton = page.getByRole("button", { name: /^Usage:/ });
  await stripButton.waitFor({ state: "visible" });
  // The sheet makes the page behind it inert, so the strip is read by CSS selector, not by role.
  const stripLabelNow = () =>
    page.locator('button[aria-label^="Usage:"]').first().getAttribute("aria-label");
  const shot = (name) => page.screenshot({ path: NodePath.join(args.out, `${name}.png`) });
  const claudeCard = () => page.locator('article[aria-label="Claude usage"]');
  const cardText = async () => (await claudeCard().innerText()).replace(/\s+/g, " ");

  if (args.phase === "seed") {
    await stripButton.tap();
    await claudeCard().waitFor({ state: "visible" });
    // The server's first probe ran before the weekly flag existed: ask for a fresh one.
    await page.getByRole("button", { name: "Refresh usage" }).tap();
    await page.waitForFunction(
      () =>
        document
          .querySelector('article[aria-label="Claude usage"]')
          ?.textContent?.includes("31% used"),
      null,
      { timeout: 30000 },
    );
    await page.waitForFunction(() => !document.body.innerText.includes("Refreshing"), null, {
      timeout: 20000,
    });
    const text = await cardText();
    const label = await stripLabelNow();
    check(
      "the strip names Claude's Session and Weekly",
      /Claude, Session 10 percent used, Weekly 31 percent used/.test(label ?? ""),
      label ?? "",
    );
    check("the card shows the 5-hour session", /10% used/.test(text), text);
    check("the card shows a weekly row", /31% used/.test(text), text);
    check("the card says how old the reading is", /Updated \w+/.test(text), text);
    check("no refresh failure on a good read", !/Couldn't refresh/.test(text), text);
    await shot("01-values");
  } else if (args.phase === "refresh") {
    await stripButton.tap();
    await claudeCard().waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.body.innerText.includes("Refreshing"), null, {
      timeout: 20000,
    });
    await page.getByRole("button", { name: "Refresh usage" }).tap();
    await page.waitForFunction(() => document.body.innerText.includes("Refreshing"), null, {
      timeout: 5000,
    });
    const text = await cardText();
    check(
      "Refreshing shows beside Updated while the probe runs",
      /Updated \w+ Refreshing/.test(text),
      text,
    );
    check(
      "the numbers stay on screen during it",
      /10% used/.test(text) && /31% used/.test(text),
      text,
    );
    check("it never falls back to Checking", !/Checking/.test(text), text);
    await shot("02-refreshing");
    await page.waitForFunction(() => !document.body.innerText.includes("Refreshing"), null, {
      timeout: 30000,
    });
    const after = await cardText();
    check(
      "after the slow probe the numbers are still there",
      /10% used/.test(after) && /31% used/.test(after),
      after,
    );
    await shot("03-refreshed-or-failed");
  } else if (args.phase === "failed" || args.phase === "restart") {
    await stripButton.tap();
    await claudeCard().waitFor({ state: "visible" });
    if (args.phase === "failed") {
      await page.getByRole("button", { name: "Refresh usage" }).tap();
    }
    // Wait for any probe in flight (open, strip and button each may ask) to settle.
    await page.waitForFunction(() => !document.body.innerText.includes("Refreshing"), null, {
      timeout: 40000,
    });
    const text = await cardText();
    check("Session value still shown", /10% used/.test(text), text);
    check("Weekly value still shown", /31% used/.test(text), text);
    check("the age of the reading is shown", /Updated \w+/.test(text), text);
    check("never a bare Checking placeholder", !/Checking/.test(text), text);
    if (args.expectFailure === "yes") {
      check("it says the refresh failed", /Couldn't refresh/.test(text), text);
      if (args.reason)
        check(`...with the reason (${args.reason})`, text.includes(args.reason), text);
    }
    const stripLabel = await stripLabelNow();
    check(
      "the strip still carries the numbers",
      /Claude, Session 10 percent used, Weekly 31 percent used/.test(stripLabel ?? ""),
      stripLabel ?? "",
    );
    await shot(args.phase === "restart" ? "05-after-restart" : `04-${args.name ?? "failed"}`);
  }
  // The suite is hermetic (no external hosts), so Clerk's script never loads: not a finding.
  const ownErrors = errors.filter((error) => !/Clerk/i.test(error));
  check("no uncaught page errors", ownErrors.length === 0, ownErrors.join(" | "));
  await context.close();
} finally {
  await browser.close();
}
if (failures > 0) {
  console.log(`${failures} failure(s).`);
  process.exit(1);
}
console.log("All passed.");
