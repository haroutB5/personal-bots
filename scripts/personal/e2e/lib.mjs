// Helpers for the phone e2e smoke suite (see README.md in this folder).
// Plain Node ESM, no build step. Playwright comes from the release under test
// (its node_modules carries playwright-core), or from the checkout.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** The phone the suite drives: 390x844, touch, dark (the team's test default). */
export const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
  locale: "en-GB",
};

/** Per-step wait. A journey as a whole must still finish inside JOURNEY_LIMIT_MS. */
export const STEP_TIMEOUT_MS = 15_000;
export const JOURNEY_LIMIT_MS = 30_000;

/**
 * Finds playwright-core: next to the server bundle under test (a release folder
 * carries it as an external), then in the checkout this script lives in.
 * `bin` is the server's dist\bin.mjs the throwaway server runs.
 */
export function loadPlaywright(bin) {
  const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const starts = [];
  if (bin) {
    let dir = NodePath.dirname(bin);
    for (let i = 0; i < 5; i += 1) {
      starts.push(NodePath.join(dir, "package.json"));
      starts.push(NodePath.join(dir, "apps", "desktop", "package.json"));
      dir = NodePath.dirname(dir);
    }
  }
  starts.push(NodePath.join(here, "..", "..", "..", "apps", "desktop", "package.json"));
  for (const start of starts) {
    const probe = NodePath.join(NodePath.dirname(start), "node_modules", "playwright-core");
    if (!NodeFS.existsSync(probe)) continue;
    const require = NodeModule.createRequire(start);
    return require("playwright-core");
  }
  throw new Error(`playwright-core not found beside ${bin ?? "the release"} or in the checkout.`);
}

/** A small timer for step and journey durations. */
export function stopwatch() {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

/** Logs a step line with the time since the journey began. */
export function stepLogger(journeyId, elapsed) {
  return (text) => console.log(`    ${String(elapsed()).padStart(5)} ms  ${journeyId}: ${text}`);
}

export async function pairContext(browser, origin, pairUrl) {
  const context = await browser.newContext(PHONE);
  await blockExternal(context, origin);
  const page = await context.newPage();
  await page.goto(pairUrl, { waitUntil: "load", timeout: 30_000 });
  // The pairing page consumes the token and sends the browser on to /bots.
  await page
    .waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 })
    .catch(() => {
      throw new Error(
        `pairing did not finish: the page stayed on ${page.url().split("#")[0]} (the app may not boot, or the pairing link was already used)`,
      );
    });
  const state = await context.storageState();
  await context.close();
  if (!state.cookies.some((cookie) => cookie.name.startsWith("t3_session"))) {
    throw new Error("Pairing left no session cookie.");
  }
  return state;
}

/** The suite is hermetic: nothing but the throwaway server is reachable (no Clerk, no CDNs). */
export async function blockExternal(context, origin) {
  const allowed = new URL(origin).origin;
  await context.route(
    (url) => url.protocol.startsWith("http") && url.origin !== allowed,
    (route) => route.abort(),
  );
}

/** A clean, signed-in phone context and page; `errors` collects uncaught page errors. */
export async function openPhone(browser, origin, storageState) {
  const context = await browser.newContext({ ...PHONE, storageState });
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  await blockExternal(context, origin);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error).split("\n")[0]));
  return { context, page, errors };
}

/** Press and hold for `holdMs` with a real touch (the app's long press is 500 ms). */
export async function longPress(context, page, locator, holdMs = 800) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("longPress: element has no box");
  const x = box.x + Math.min(40, box.width / 2);
  const y = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await page.waitForTimeout(holdMs);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** The seeded fake bots a throwaway root starts with (PERSONAL_SEED_MODEL, fake Claude CLI). */
export const botId = (name) => `personal-seed-${name.toLowerCase()}`;

export async function openBots(page, origin) {
  await page.goto(`${origin}/bots`, { waitUntil: "load" });
  await page.getByLabel("Search bots and chats").waitFor({ state: "visible" });
}

/** The composer, once a chat is open. */
export const composer = (page) => page.getByPlaceholder(/^Message/);

export async function send(page, text) {
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).tap();
}

/** The transcript. */
export const transcript = (page) => page.locator('[role="log"]');

/** Confirms the name sheet that every New chat button opens, with an optional name. */
export async function startChatFromSheet(page, name) {
  const field = page.getByLabel("Chat name (optional)");
  await field.waitFor({ state: "visible" });
  if (name) await field.fill(name);
  await page.getByRole("button", { name: "Start chat", exact: true }).tap();
  await composer(page).waitFor({ state: "visible" });
}

/** Opens /bots/<bot> and starts a new chat from its New chat button. */
export async function newChatOnBotScreen(page, origin, bot, name) {
  await page.goto(`${origin}/bots/${botId(bot)}`, { waitUntil: "load" });
  await page.getByRole("button", { name: "New chat", exact: true }).tap();
  await startChatFromSheet(page, name);
}
