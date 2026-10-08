// The phone itself loses its network (1.66.11): a tube, a lift, airplane mode. Four journeys in the default gate.
//   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\e2e-smoke.ps1 -Release <sha12> -Journey offline-network
//
// `offline-queue` takes the laptop away (the server goes down) and the phone keeps its network. Here the server stays
// up and the browser loses everything (Playwright `context.setOffline(true)`: pages, chunks, the socket), which is
// what a phone with no signal does. What it proves, in a 390x844 dark phone:
//  offline-network   a chat that has been open a while keeps its composer and the "Reconnecting" banner, a message sent
//                    there shows "Waiting to send", nothing reloads, and it reaches the bot exactly once (database)
//                    when the network returns
//  cold-load-drop    the same when the network goes a few seconds after a COLD page load (the deferred dialogs and the
//                    code-highlighting chunks have not been fetched yet and now cannot be): no reload into the root
//                    "Laptop offline" screen
//  offline-screens   Bots list, Team, Memory and Files keep their content and the banner (no root fallback, no reload)
//  stale-deploy      recovery from a stale deploy still works while the server answers: a newer release named by
//                    /version.txt reloads the app once, a chunk that 404s reloads it once, neither loops
//  revoked-session   a session the laptop revoked still signs the phone out (back to the pairing page)
import { expect } from "./expect.mjs";
import { splitPageErrors, describePageErrors } from "./page-errors.mjs";
import {
  PHONE,
  STEP_TIMEOUT_MS,
  blockExternal,
  composer,
  newChatOnBotScreen,
  openBots,
  pairContext,
  startChatFromSheet,
  transcript,
} from "./lib.mjs";
import { sendButton, typeAndSend, userMessages, waitingRows } from "./offlineQueue.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ONLINE = "Hello while connected";

/** Counts full page loads, collects failed requests and uncaught page errors of one page. */
function watchPage(page) {
  const state = { loads: 0, failed: [], errors: [] };
  page.on("load", () => {
    state.loads += 1;
  });
  page.on("requestfailed", (request) => {
    state.failed.push(
      request
        .url()
        .replace(/^https?:\/\/[^/]+/, "")
        .slice(0, 80),
    );
  });
  page.on("pageerror", (error) => state.errors.push(String(error).split("\n")[0]));
  return {
    loads: () => state.loads,
    errors: state.errors,
    failedSummary: () => {
      const counts = new Map();
      for (const url of state.failed) counts.set(url, (counts.get(url) ?? 0) + 1);
      return [...counts].map(([url, n]) => `${url} x${n}`).join(", ") || "none";
    },
  };
}

/** A second phone from the first one's session, with an empty cache: as a page loaded for the first time. */
async function coldPhone(context, origin) {
  const state = await context.storageState();
  const fresh = await context.browser().newContext({ ...PHONE, storageState: state });
  fresh.setDefaultTimeout(STEP_TIMEOUT_MS);
  await blockExternal(fresh, origin);
  const page = await fresh.newPage();
  return { context: fresh, page, watch: watchPage(page) };
}

/** Fails the journey on an uncaught error in a page the runner does not watch itself. */
function assertNoPageErrors(id, watch) {
  const { unexpected } = splitPageErrors(watch.errors);
  if (unexpected.length > 0) throw new Error(describePageErrors(id, unexpected));
}

/**
 * The root "Laptop offline" screen (an h1 of its own with a Try again button): the thing a phone with no network
 * must never fall back to. The Bots list has its own small "Your laptop is offline" card with a Try again button,
 * and the banner says "Laptop offline" too; only the full-screen heading is the fallback.
 */
async function expectNoFallback(page) {
  if ((await page.getByRole("heading", { name: "Laptop offline" }).count()) > 0) {
    throw new Error("the app fell back to the root 'Laptop offline' screen");
  }
}

/** The page has been open a while: shell saved by the service worker, deferred dialogs loaded, a chat open and quiet. */
async function warmChat(page, origin, title) {
  await openBots(page, origin);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload({ waitUntil: "load" });
  await page.getByLabel("Search bots and chats").waitFor({ state: "visible" });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .some((entry) => /ThemeEditorHost/.test(entry.name)),
        ),
      { timeout: 40_000 },
    )
    .toBe(true);
  await page.getByText("Planner", { exact: true }).first().tap();
  await startChatFromSheet(page, title);
  await typeAndSend(page, ONLINE);
  await expect(transcript(page).getByText("Got it.")).toBeVisible();
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(3_000);
}

/** The phone is offline: composer and banner are still there and say messages are kept. */
async function expectKeptOffline(page) {
  await expect(page.getByText(/Reconnecting to your laptop|Laptop offline/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Messages you send now are saved/)).toBeVisible();
  await composer(page).fill("probe");
  if (await sendButton(page).isDisabled()) throw new Error("Send is disabled while offline");
  await composer(page).fill("");
}

/** Stays on the page while offline long enough for every timer and retry to have run, then checks nothing reloaded. */
async function stayOffline(page, watch, loadsBefore, ms) {
  await page.waitForTimeout(ms);
  if (watch.loads() !== loadsBefore) {
    throw new Error(`the page reloaded while offline (${watch.loads() - loadsBefore} load(s))`);
  }
  const alive = await page.evaluate(() => window.__e2eAlive === true).catch(() => false);
  if (!alive) throw new Error("the page state was lost while offline (it reloaded)");
  await expectNoFallback(page);
  await expect(composer(page)).toBeVisible();
  await expect(page.getByText(/Reconnecting to your laptop|Laptop offline/)).toBeVisible();
}

/** The queued message reaches the bot exactly once, in the server's own database, and the queue empties. */
async function expectDeliveredOnce(page, root, title, text, step) {
  await expect
    .poll(
      () =>
        userMessages(root, title)
          .map((message) => message.text)
          .join("|"),
      { timeout: 60_000 },
    )
    .toBe([ONLINE, text].join("|"));
  const delivered = userMessages(root, title);
  if (delivered.some((message) => message.turns !== 1)) {
    throw new Error(`a message started more or fewer than one turn: ${JSON.stringify(delivered)}`);
  }
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("t3.personal.outbox.v1")), {
      timeout: 30_000,
    })
    .toBe("[]");
  await expect(waitingRows(page)).toBeHidden();
  await expect(transcript(page)).toContainText(text, { timeout: 30_000 });
  const shown = ((await transcript(page).innerText()).match(new RegExp(text, "g")) ?? []).length;
  if (shown !== 1) throw new Error(`"${text}" shows ${shown} times in the chat`);
  step(
    "on the server: one message and one turn (database); the queue is empty; shown once in the chat",
  );
}

async function phoneLosesNetwork({ page, context, origin, step, root }) {
  const title = "E2E phone offline";
  const message = "Sent with no signal at all";
  const watch = watchPage(page);
  await warmChat(page, origin, title);
  await page.evaluate(() => {
    window.__e2eAlive = true;
  });
  const loadsBefore = watch.loads();
  step("chat open for a while, deferred code loaded, one message sent while connected");

  await context.setOffline(true);
  await expectKeptOffline(page);
  step("whole network gone: the composer and the Reconnecting banner stay, Send is live");
  await typeAndSend(page, message);
  await expect(waitingRows(page)).toHaveCount(1);
  await expect(page.getByText("Waiting to send")).toBeVisible();
  step("a message sent with no network shows Waiting to send");
  await stayOffline(page, watch, loadsBefore, 20_000);
  step(
    `20 s offline: no reload, no root fallback, composer and banner still there (failed requests: ${watch.failedSummary()})`,
  );

  await context.setOffline(false);
  await expectDeliveredOnce(page, root, title, message, step);
  assertNoPageErrors("offline-network", watch);
}

async function coldLoadDrop({ page, context, origin, step, root }) {
  const title = "E2E cold load drop";
  const message = "Sent after the signal dropped on a cold start";
  // The chat exists already; the phone below opens it from nothing: no service worker, no cached chunks.
  await newChatOnBotScreen(page, origin, "Planner", title);
  await typeAndSend(page, ONLINE);
  await expect(transcript(page).getByText("Got it.")).toBeVisible();
  const chatUrl = page.url();
  const cold = await coldPhone(context, origin);
  try {
    await cold.page.goto(chatUrl, { waitUntil: "commit" });
    await cold.page.evaluate(() => {
      window.__e2eAlive = true;
    });
    await composer(cold.page).waitFor({ state: "visible", timeout: 30_000 });
    const loadsBefore = cold.watch.loads();
    await cold.context.setOffline(true);
    step("cold page: the chat is up and the network goes a few seconds in");
    await expectKeptOffline(cold.page);
    await typeAndSend(cold.page, message);
    await expect(waitingRows(cold.page)).toHaveCount(1);
    step("a message sent there shows Waiting to send");
    // The dialogs the app fetches ten seconds after it settles, and the chunks of the first reply, fail now.
    await stayOffline(cold.page, cold.watch, loadsBefore, 25_000);
    step(
      `25 s offline: no reload, no root fallback (failed requests: ${cold.watch.failedSummary()})`,
    );
    await cold.context.setOffline(false);
    await expectDeliveredOnce(cold.page, root, title, message, step);
    assertNoPageErrors("cold-load-drop", cold.watch);
  } finally {
    await cold.context.close().catch(() => undefined);
  }
}

async function screensKeepContent({ page, context, origin, step }) {
  const watch = watchPage(page);
  const list = page.getByLabel("Search bots and chats");
  const heading = (name) => page.getByRole("heading", { name, exact: true });
  const tab = (name) =>
    page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name });
  await openBots(page, origin);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload({ waitUntil: "load" });
  await list.waitFor({ state: "visible" });

  // The tour the owner makes: every screen opened once while connected, so its code and data are on the page.
  const visit = async (label, open, shown) => {
    await open();
    await expect(shown).toBeVisible({ timeout: 20_000 });
    step(`opened ${label}`);
  };
  // Memory is a page without the tab bar: back out of it (and of Settings) with the history.
  const backToTabs = async () => {
    for (let i = 0; i < 3 && (await tab("Chats").count()) === 0; i += 1) {
      await page.goBack();
      await page.waitForTimeout(400);
    }
    await expect(tab("Chats")).toBeVisible();
  };
  const tour = [
    ["Team", () => page.getByRole("link", { name: "Team" }).first().tap(), heading("Team")],
    [
      "Memory",
      async () => {
        await backToTabs();
        await tab("Chats").tap();
        await page.getByRole("link", { name: "Settings" }).first().tap();
        await page
          .getByRole("link", { name: /^Memory/ })
          .first()
          .tap();
      },
      heading("Memory"),
    ],
    [
      "Files",
      async () => {
        await backToTabs();
        await tab("Files").tap();
      },
      heading("Files"),
    ],
    ["the Bots list", () => tab("Chats").tap(), list],
  ];
  for (const [label, open, shown] of tour) await visit(label, open, shown);
  await expect(page.getByText("Planner", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(12_000);
  await page.evaluate(() => {
    window.__e2eAlive = true;
  });
  const loadsBefore = watch.loads();

  await context.setOffline(true);
  await expect(page.getByText(/Reconnecting to your laptop|Laptop offline/)).toBeVisible({
    timeout: 30_000,
  });
  const checkScreen = async (label, shown, content) => {
    await expect(shown).toBeVisible();
    if (content) await expect(content).toBeVisible();
    await expect(page.getByText(/Reconnecting to your laptop|Laptop offline/)).toBeVisible();
    await expectNoFallback(page);
    if (watch.loads() !== loadsBefore) throw new Error(`${label}: the page reloaded while offline`);
    if (!(await page.evaluate(() => window.__e2eAlive === true))) {
      throw new Error(`${label}: the page state was lost while offline`);
    }
    step(`offline, ${label}: content and the banner stay, no root fallback`);
  };
  await checkScreen("the Bots list", list, page.getByText("Planner", { exact: true }));
  await page.getByRole("link", { name: "Team" }).first().tap();
  await checkScreen("Team", heading("Team"), page.getByText("Planner", { exact: true }));
  await backToTabs();
  await tab("Chats").tap();
  await page.getByRole("link", { name: "Settings" }).first().tap();
  await page
    .getByRole("link", { name: /^Memory/ })
    .first()
    .tap();
  await checkScreen("Memory", heading("Memory"));
  await backToTabs();
  await tab("Files").tap();
  await checkScreen("Files", heading("Files"));
  await tab("Chats").tap();
  await page.waitForTimeout(15_000);
  await checkScreen("the Bots list after 15 s", list, page.getByText("Planner", { exact: true }));

  await context.setOffline(false);
  await expect(page.getByText(/Reconnecting to your laptop|Laptop offline/)).toBeHidden({
    timeout: 60_000,
  });
  step("network back: the banner goes away");
  assertNoPageErrors("offline-screens", watch);
}

async function staleDeploy({ context, origin, step }) {
  // 1. The server names a newer release than the one the page runs: the boot check reloads once, and does not loop.
  const stale = await coldPhone(context, origin);
  try {
    await stale.context.route("**/version.txt", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: "version=9.9.9\nrelease=aaaaaaaaaaaa\nclient=index-NEWERRELEASE.js\n",
      }),
    );
    await stale.page.goto(`${origin}/bots`, { waitUntil: "load" });
    await expect.poll(() => stale.watch.loads(), { timeout: 20_000 }).toBe(2);
    await stale.page.getByLabel("Search bots and chats").waitFor({ state: "visible" });
    await sleep(4_000);
    if (stale.watch.loads() !== 2) {
      throw new Error(
        `the stale-release check reloaded ${stale.watch.loads()} times, expected exactly 2 loads`,
      );
    }
    step("a newer release named by /version.txt: the app reloaded once and then stayed (2 loads)");
    assertNoPageErrors("stale-deploy", stale.watch);
  } finally {
    await stale.context.close().catch(() => undefined);
  }

  // 2. A lazy chunk 404s while the server answers (its hashed file is gone after a deploy): one reload, no loop.
  const gone = await coldPhone(context, origin);
  try {
    await gone.context.route(/\/assets\/ThemeEditorHost-[^/]*\.js/, (route) =>
      gone.watch.loads() <= 1
        ? route.fulfill({ status: 404, contentType: "text/plain", body: "gone" })
        : route.continue(),
    );
    await gone.page.goto(`${origin}/bots`, { waitUntil: "load" });
    await expect.poll(() => gone.watch.loads(), { timeout: 45_000 }).toBe(2);
    await gone.page.getByLabel("Search bots and chats").waitFor({ state: "visible" });
    await sleep(14_000);
    if (gone.watch.loads() !== 2) {
      throw new Error(
        `a 404 chunk reloaded the app ${gone.watch.loads() - 1} times, expected once`,
      );
    }
    await expectNoFallback(gone.page);
    step(
      "a lazy chunk that 404s while the server answers: the app reloaded once and recovered (2 loads)",
    );
    assertNoPageErrors("stale-deploy", gone.watch);
  } finally {
    await gone.context.close().catch(() => undefined);
  }
}

async function revokedSession({ context, origin, step, auth }) {
  if (!auth)
    throw new Error("this journey needs the server's auth controls: run it through e2e-smoke.ps1");
  // Its own session, so revoking it does not sign the other journeys out.
  const before = new Set(await auth.sessionIds());
  const state = await pairContext(context.browser(), origin, await auth.pairingLink());
  const own = (await auth.sessionIds()).filter((id) => !before.has(id));
  if (own.length !== 1) throw new Error(`expected one new session, found ${own.length}`);
  const phone = await context.browser().newContext({ ...PHONE, storageState: state });
  phone.setDefaultTimeout(STEP_TIMEOUT_MS);
  await blockExternal(phone, origin);
  try {
    const page = await phone.newPage();
    const watch = watchPage(page);
    await openBots(page, origin);
    step("a phone with its own session is on the Bots list");
    await auth.revokeSession(own[0]);
    step("the laptop revoked this phone's session");
    await page.reload({ waitUntil: "load" });
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe("/pair");
    await expect(page.getByLabel("Search bots and chats")).toBeHidden();
    step("after the revoke the app signs out: it is on the pairing page, not the Bots list");
    assertNoPageErrors("revoked-session", watch);
  } finally {
    await phone.close().catch(() => undefined);
  }
}

export const NETWORK_JOURNEYS = [
  {
    id: "offline-network",
    title:
      "Phone loses all network: composer and banner stay, Waiting to send, no reload, delivered once",
    limitMs: 150_000,
    run: phoneLosesNetwork,
  },
  {
    id: "cold-load-drop",
    title: "Network drops seconds after a cold load: no reload into the Laptop offline screen",
    limitMs: 150_000,
    run: coldLoadDrop,
  },
  {
    id: "offline-screens",
    title:
      "Bots list, Team, Memory and Files keep their content and the banner when the network drops",
    limitMs: 150_000,
    run: screensKeepContent,
  },
  {
    id: "stale-deploy",
    title: "Stale deploy recovery still works: newer release and a 404 chunk reload once",
    limitMs: 120_000,
    run: staleDeploy,
  },
  {
    id: "revoked-session",
    title: "A revoked session still signs the phone out",
    limitMs: 60_000,
    run: revokedSession,
  },
];
