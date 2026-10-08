// The offline send queue (1.66.10) against a real throwaway server that really goes away.
// Opt-in, not part of the five-journey smoke: it stops and restarts the server (throwaway-server.ps1
// -Down / -Up, same root and port), which takes longer than a smoke journey may.
//   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\personal\e2e-smoke.ps1 -Release <sha12> -Journey offline-queue
//
// What it proves, in a 390x844 dark phone:
//  1. a message sent while the server is down shows "Waiting to send" and survives a page reload
//  2. several waiting messages reach the bot in the order they were typed, each exactly once, once the server is back
//  3. Cancel removes a waiting message and Edit puts it back in the composer
//  4. a send whose reply is lost on the way back (the server got it, the phone never heard) is not posted twice
// "Exactly once" is checked in the server's own database, not only on screen.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect } from "./expect.mjs";
import { composer, newChatOnBotScreen, openBots, transcript } from "./lib.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Words differ in more than the last one: the composer drops a keyboard "echo" of the text just sent, and
// "offline one" then "offline two" looks like one (the same guard protects every send).
const ONLINE = "Hello while connected";
const M1 = "Please check the release notes";
const M2 = "Cancel me before the laptop is back";
const M3 = "Remind me about the dentist tomorrow";
const TYPO = "A typo to edit and retype";
const M4 = "Then tell me the weather";
const LOST = "This reply gets lost on the way back";

/** The phone's socket to the laptop, routed through this script so a test can lose replies and drop it. */
async function routeSocket(page) {
  const wire = {
    swallow: false,
    sockets: [],
    dropAll: () => wire.sockets.forEach((s) => s.close()),
  };
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const upstream = ws.connectToServer();
    const handle = {
      close: () => {
        void ws.close().catch(() => undefined);
        void upstream.close().catch(() => undefined);
      },
    };
    wire.sockets.push(handle);
    ws.onMessage((message) => upstream.send(message));
    upstream.onMessage((message) => {
      if (!wire.swallow) ws.send(message);
    });
    ws.onClose(() => void upstream.close().catch(() => undefined));
    upstream.onClose(() => void ws.close().catch(() => undefined));
  });
  return wire;
}

/** Reads the server's own database (read only): what actually reached the bot. */
function openDatabase(root) {
  const file = NodePath.join(root, "userdata", "state.sqlite");
  if (!NodeFS.existsSync(file)) throw new Error(`no database at ${file}`);
  return new DatabaseSync(file, { readOnly: true });
}

/** User messages of the chat with this title, oldest first, and how many turns each started. */
export function userMessages(root, threadTitle) {
  const db = openDatabase(root);
  try {
    const thread = db
      .prepare(
        "SELECT thread_id AS id FROM projection_threads WHERE title = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(threadTitle);
    if (!thread) return [];
    const sent = db
      .prepare(
        "SELECT sequence, json_extract(payload_json, '$.messageId') AS messageId, json_extract(payload_json, '$.text') AS text " +
          "FROM orchestration_events WHERE event_type = 'thread.message-sent' AND stream_id = ? " +
          "AND json_extract(payload_json, '$.role') = 'user' ORDER BY sequence",
      )
      .all(thread.id);
    const turns = db
      .prepare(
        "SELECT json_extract(payload_json, '$.messageId') AS messageId FROM orchestration_events " +
          "WHERE event_type = 'thread.turn-start-requested' AND stream_id = ?",
      )
      .all(thread.id);
    return sent.map((row) => ({
      text: row.text,
      messageId: row.messageId,
      turns: turns.filter((turn) => turn.messageId === row.messageId).length,
    }));
  } finally {
    db.close();
  }
}

export const sendButton = (page) =>
  page.getByRole("button", { name: /^Send/ }).filter({ visible: true }).first();

export async function typeAndSend(page, text) {
  await composer(page).fill(text);
  await sendButton(page).tap();
}

export const waitingRows = (page) => page.locator("[data-queued-message]");

async function offlineQueue({ page, origin, step, server, root }) {
  if (!server || !root) {
    throw new Error(
      "this journey needs the throwaway server controls: run it through e2e-smoke.ps1",
    );
  }
  const title = "E2E offline queue";
  const wire = await routeSocket(page);

  await openBots(page, origin);
  // As on a phone that has had the app open a while: the service worker has saved the app shell (a reload while
  // the laptop is away is answered from it) and the app has loaded its deferred chunks (the dialogs it mounts
  // ten seconds after it settles). A laptop that drops in the first seconds of a cold page cannot be tested fairly.
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
  // Through the bot's own page: in the full gate, earlier journeys have already given other bots chats (and the fake CLI replays a delegating chat), so a tap on a bot's
  // row no longer opens the name sheet. Researcher is the bot no earlier journey sends messages to.
  await newChatOnBotScreen(page, origin, "Researcher", title);
  await typeAndSend(page, ONLINE);
  await expect(transcript(page).getByText("Got it.")).toBeVisible();
  // The first reply loads the code-highlighting chunks while it is written. Let the page go quiet, as a phone
  // would have before its owner walks out of Wi-Fi range.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(3_000);
  step("shell saved by the service worker, chat open, one message sent while connected");

  // ---- the laptop goes away
  await server.down();
  await expect(page.getByText(/Reconnecting to your laptop|Laptop offline/)).toBeVisible({
    timeout: 25_000,
  });
  await expect(page.getByText(/Messages you send now are saved/)).toBeVisible();
  // Send is greyed only while the field is empty; with text in it, it must be live while the laptop is away.
  await composer(page).fill("probe");
  if (await sendButton(page).isDisabled())
    throw new Error("Send is disabled while the laptop is away");
  await composer(page).fill("");
  step("laptop is down: banner and composer say messages are kept, Send stays enabled");

  await typeAndSend(page, M1);
  await typeAndSend(page, M2);
  await typeAndSend(page, M3);
  await expect(waitingRows(page)).toHaveCount(3);
  await expect(page.getByText("Waiting to send")).toBeVisible();
  await expect(page.getByText("3 messages are waiting to send")).toBeVisible();
  step("three messages show Waiting to send, the banner counts them");

  // ---- Cancel removes one, Edit hands one back to the composer
  await waitingRows(page).filter({ hasText: M2 }).getByRole("button", { name: "Cancel" }).tap();
  await expect(waitingRows(page)).toHaveCount(2);
  await expect(page.getByText(M2)).toBeHidden();
  await typeAndSend(page, TYPO);
  await waitingRows(page).filter({ hasText: TYPO }).getByRole("button", { name: "Edit" }).tap();
  await expect.poll(() => composer(page).inputValue()).toBe(TYPO);
  await composer(page).fill(M4);
  await sendButton(page).tap();
  await expect(waitingRows(page)).toHaveCount(3);
  step("Cancel removed one, Edit moved one back to the composer and it was retyped");

  // ---- the page is reloaded while the laptop is still away
  const queued = await page.evaluate(() => window.localStorage.getItem("t3.personal.outbox.v1"));
  const saved = JSON.parse(queued ?? "[]").map((entry) => entry.text);
  if (saved.join("|") !== [M1, M3, M4].join("|")) {
    throw new Error(`the queue on the device is ${JSON.stringify(saved)}`);
  }
  let reloadedWhileDown = true;
  try {
    await page.reload({ waitUntil: "load", timeout: 15_000 });
  } catch {
    reloadedWhileDown = false;
  }
  if (reloadedWhileDown) {
    // The service worker opens the app from its saved shell; the laptop cannot be reached, so it is the cold-launch
    // "Laptop offline" screen, and it says the messages are still here.
    await expect(page.getByText("Laptop offline")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("3 messages are waiting to send")).toBeVisible();
    step(
      "reloaded while the laptop was down: the Laptop offline screen says 3 messages are waiting",
    );
  } else {
    step(
      "the app shell does not load without the laptop (no cache here); the queue is on the device",
    );
  }
  const afterReload = await page.evaluate(() => {
    try {
      return window.localStorage.getItem("t3.personal.outbox.v1");
    } catch {
      return null;
    }
  });
  if (reloadedWhileDown && JSON.parse(afterReload ?? "[]").length !== 3) {
    throw new Error("the queue did not survive the reload");
  }

  // ---- the laptop comes back
  await server.up();
  const botsList = page.getByLabel("Search bots and chats");
  const chatOpen = composer(page).filter({ visible: true });
  const appOpen = async (timeout) => {
    await Promise.race([
      botsList.waitFor({ state: "visible", timeout }),
      chatOpen.first().waitFor({ state: "visible", timeout }),
    ]);
  };
  if (reloadedWhileDown) {
    // The app keeps retrying its sign-in by itself and opens (on the page it was on) once the laptop answers;
    // Try again is the same retry.
    const opened = await appOpen(25_000).then(
      () => true,
      () => false,
    );
    if (!opened) await page.getByRole("button", { name: "Try again" }).tap();
  } else {
    await page.goto(`${origin}/bots`, { waitUntil: "load" });
  }
  await appOpen(30_000);
  step("laptop is back, the app is open again");
  // The queue sends by itself, wherever the owner is. Open the chat to read it.
  await expect
    .poll(
      () =>
        userMessages(root, title)
          .map((message) => message.text)
          .join("|"),
      {
        timeout: 60_000,
      },
    )
    .toBe([ONLINE, M1, M3, M4].join("|"));
  const delivered = userMessages(root, title);
  if (delivered.some((message) => message.turns !== 1)) {
    throw new Error(`a message started more or fewer than one turn: ${JSON.stringify(delivered)}`);
  }
  step("on the server: the three messages arrived once each, in order, one turn each (database)");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("t3.personal.outbox.v1")), {
      timeout: 30_000,
    })
    .toBe("[]");
  step("the queue on the device is empty");

  // ---- on screen too: open the chat
  if ((await chatOpen.count()) === 0) await page.getByText(title, { exact: true }).first().tap();
  await expect(transcript(page).getByText(M4)).toBeVisible({ timeout: 30_000 });
  const text = (await transcript(page).innerText()).replace(/\s+/g, " ");
  for (const needle of [M1, M3, M4]) {
    const count = text.split(needle).length - 1;
    if (count !== 1) throw new Error(`"${needle}" shows ${count} times in the chat`);
  }
  if (text.includes(M2) || text.includes(TYPO)) {
    throw new Error("a cancelled or edited message reached the chat");
  }
  if (!(text.indexOf(M1) < text.indexOf(M3) && text.indexOf(M3) < text.indexOf(M4))) {
    throw new Error("the messages are out of order in the chat");
  }
  await expect(page.getByText("Waiting to send")).toBeHidden();
  step("on screen: once each, in order, nothing waiting");

  // ---- a reply lost on the way back: the server has the message, the phone never hears
  const before = userMessages(root, title).length;
  wire.swallow = true;
  await typeAndSend(page, LOST);
  await expect.poll(() => userMessages(root, title).length, { timeout: 20_000 }).toBe(before + 1);
  step("the server has the message; its reply never reached the phone");
  wire.swallow = false;
  wire.dropAll();
  await expect(page.getByText("Waiting to send")).toBeHidden({ timeout: 40_000 });
  await sleep(4_000);
  const after = userMessages(root, title);
  const lost = after.filter((message) => message.text === LOST);
  if (lost.length !== 1 || lost[0].turns !== 1 || after.length !== before + 1) {
    throw new Error(`the lost-reply message was duplicated: ${JSON.stringify(after.slice(-3))}`);
  }
  const shown = ((await transcript(page).innerText()).match(new RegExp(LOST, "g")) ?? []).length;
  if (shown !== 1) throw new Error(`"${LOST}" shows ${shown} times in the chat`);
  step("the connection dropped mid-send and nothing was posted twice (one message, one turn)");
}

export const OFFLINE_JOURNEYS = [
  {
    id: "offline-queue",
    title: "Offline send queue: Waiting to send, reload, in order, exactly once, lost reply",
    limitMs: 180_000,
    run: offlineQueue,
  },
];
