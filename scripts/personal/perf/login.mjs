// Saves a signed-in browser state for the perf bench (cookies only, kept
// outside the repo under %USERPROFILE%\.personal-bots\perf\).
//   node scripts/personal/perf/login.mjs "<pairing URL with #token=...>"
// Mint the URL with scripts\personal\pair.ps1 (relay) or
// `node <release>\dist\bin.mjs pair --ttl 10m --label perf-bench --base-dir <root>` (local).
import { chromium, authStatePath } from "./lib.mjs";

const pairUrl = process.argv[2];
if (!pairUrl || !pairUrl.includes("#token=")) {
  console.error("usage: node login.mjs <pairing URL>");
  process.exit(2);
}
const origin = new URL(pairUrl).origin;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(pairUrl, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(3000);
const cookies = (await context.cookies()).filter((c) => c.name.startsWith("t3_session"));
if (cookies.length === 0) {
  console.error("no session cookie after pairing; landed at", page.url());
  await browser.close();
  process.exit(1);
}
const file = authStatePath(origin);
await context.storageState({ path: file });
console.log(`saved ${cookies.length} session cookie(s) for ${origin} -> ${file}`);
await browser.close();
