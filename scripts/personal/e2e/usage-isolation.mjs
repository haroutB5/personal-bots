// 1.66.33 isolation check: a throwaway server's Team token usage card must not
// show any tokens, because the usage scan must not read anything outside the
// throwaway root. On the real machine the card would otherwise show the
// machine's own Claude/OpenCode/DeepSeek histories (QA 1.66.29 saw OpenCode
// 84.2M on a throwaway), which is exactly the failure this fails on.
//
// Driven by ../qa-16633.ps1 after throwaway-server.ps1 started a FRESH root
// (throwaway-server.ps1 now points every scan home inside the root itself; the
// settings.json homePaths and the GROK_HOME / OPENCODE_DATA_DIR /
// ANTIGRAVITY_DATA_DIR env vars do that). Needs a pairing link for the root.
//
// Usage: node usage-isolation.mjs --origin <url> --pair <pairing-url> --bin <playwright dir> --out <dir>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { loadPlaywright, openPhone, pairContext } from "./lib.mjs";

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
  await page.goto(`${args.origin}/bots/team`);
  const card = page.locator('[data-testid="token-usage"]');
  await card.waitFor({ state: "visible", timeout: 30_000 });
  // A fresh root scans on open; wait until "Updated ..." shows the scan settled.
  await page
    .waitForFunction(
      () =>
        document
          .querySelector('[data-testid="token-usage-updated"]')
          ?.textContent?.includes("Updated"),
      null,
      { timeout: 60_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(500);
  const providers = await page
    .locator('[data-testid="token-usage-providers"]')
    .innerText()
    .catch(() => "");
  const total = await page
    .locator('[data-testid="token-usage-providers-total"]')
    .innerText()
    .catch(() => "");
  const outside = await page
    .locator('[data-testid="token-usage-outside"]')
    .innerText()
    .catch(() => "");
  console.log("  providers:", JSON.stringify(providers));
  console.log("  total:", JSON.stringify(total), "outside:", JSON.stringify(outside));
  // The leak signatures QA saw: "OpenCode 84.2M not priced 82%", "Claude 6.0M".
  // A fresh root has empty homes, so any token count or share here was read
  // from outside the root.
  const leak = /(\d+(\.\d+)?\s?[kMB]\b)|([1-9]\d*\s?%)/i;
  check("no provider row shows tokens", !leak.test(providers), providers);
  check("the total carries no tokens", !leak.test(total), total);
  check("no outside-bots tokens", !leak.test(outside), outside);
  await page.screenshot({ path: NodePath.join(args.out, "usage-isolation.png") });
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
