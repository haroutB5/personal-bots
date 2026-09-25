// Send prep: how long the server takes from a user's send to the provider
// turn running (thread.turn-start-requested -> first thread.session-set with
// status "running"), for a first turn and for a chat whose session is gone.
//
//   node scripts/personal/perf/prewarm.mjs --origin http://localhost:38591 \
//     --db <throwaway root>\userdata\state.sqlite [--chat /bots/<bot>/<thread>] [--settle 8000]
//
// Opens the chat (a NEW chat with --botPath when --chat is omitted), waits
// --settle ms (the session prewarm runs in that window), sends a one-word
// prompt and waits for the reply. The prep time is read from the server's own
// event log, read-only. Run it against a throwaway server only: it costs one
// small model turn per run. To get a "session gone" chat, restart the
// throwaway server and pass the printed --chat again.
import * as NodeSqlite from "node:sqlite";
import { chromium, resolveOrigin, authStatePath, round } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v, i, a) => (v.startsWith("--") ? [v.slice(2), a[i + 1] ?? true] : null))
    .filter(Boolean),
);
const origin = resolveOrigin(args.origin ?? "local");
if (/:3847[23]$/.test(origin)) {
  console.error("refusing the live server: point --origin at a throwaway server");
  process.exit(2);
}
if (typeof args.db !== "string") {
  console.error("--db <throwaway state.sqlite> is required");
  process.exit(2);
}
const settleMs = Number(args.settle ?? 8000);
const botPath = args.botPath ?? "/bots/personal-seed-assistant";
const PROMPT = "Reply with just the word OK. Do not use any tools.";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  storageState: authStatePath(origin),
});
if (typeof args.off === "string") {
  await context.addInitScript((value) => {
    try {
      localStorage.setItem("bots:perf-off", value);
    } catch {}
  }, args.off);
}
const page = await context.newPage();
const openedAt = new Date();
if (typeof args.chat === "string") {
  await page.goto(origin + args.chat, { waitUntil: "domcontentloaded", timeout: 60000 });
} else {
  await page.goto(origin + botPath, { waitUntil: "networkidle", timeout: 60000 });
  await page
    .getByRole("button", { name: /new chat/i })
    .or(page.getByRole("link", { name: /new chat/i }))
    .first()
    .click();
  await page.waitForURL(/\/bots\/[^/]+\/[0-9a-f-]{36}/, { timeout: 30000 });
}
const chatPath = new URL(page.url()).pathname;
const threadId = chatPath.split("/").at(-1);
await page.waitForSelector('textarea[placeholder^="Message"]', { timeout: 30000 });
await page.waitForTimeout(settleMs);
await page
  .getByPlaceholder(/Message/i)
  .first()
  .fill(PROMPT);
const sentAt = new Date();
await page.getByRole("button", { name: "Send" }).first().click();
for (let i = 0; i < 480; i++) {
  await page.waitForTimeout(250);
  const stop = await page.locator('button[aria-label="Stop"]').count();
  if (i > 8 && stop === 0) break;
}
await page.waitForTimeout(1000);
await browser.close();

const db = new NodeSqlite.DatabaseSync(args.db, { readOnly: true });
const rows = db
  .prepare(
    `SELECT event_type, occurred_at, payload_json FROM orchestration_events
     WHERE stream_id = ? AND occurred_at >= ? AND event_type IN
       ('thread.turn-start-requested', 'thread.session-set')
     ORDER BY sequence`,
  )
  .all(threadId, openedAt.toISOString());
db.close();
const ms = (iso) => Date.parse(iso);
const timeline = rows.map((row) => {
  const payload = JSON.parse(row.payload_json);
  return {
    type: row.event_type === "thread.turn-start-requested" ? "turn-start" : "session",
    status: payload.session?.status ?? null,
    atMs: ms(row.occurred_at) - openedAt.getTime(),
  };
});
const start = timeline.find((entry) => entry.type === "turn-start");
const running =
  start === undefined
    ? undefined
    : timeline.find(
        (entry) =>
          entry.type === "session" && entry.status === "running" && entry.atMs >= start.atMs,
      );
console.log(
  JSON.stringify({
    prepMs: start && running ? round(running.atMs - start.atMs) : null,
    chat: chatPath,
    settleMs,
    off: args.off ?? null,
    sendAtMs: sentAt.getTime() - openedAt.getTime(),
    timeline,
  }),
);
