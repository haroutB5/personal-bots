// The five phone journeys of the e2e smoke suite. Each one starts in a clean
// signed-in browser context and uses chats it makes itself, so they pass in any
// order and alone. The server is a throwaway root with a fake Claude CLI: it
// answers "Got it.", `MCPTOOL <tool> <json>` calls an MCP tool and `TASKDONE`
// finishes a delegated task (scripts/personal/testing/fake-claude/cli.js).
import { expect } from "./expect.mjs";
import {
  botId,
  composer,
  longPress,
  newChatOnBotScreen,
  openBots,
  send,
  startChatFromSheet,
  transcript,
} from "./lib.mjs";

/** Tap a bot on the Bots list, then a chat opens: list -> chat -> message -> the fake's reply. */
async function botsListChat({ page, origin, step }) {
  await openBots(page, origin);
  for (const bot of ["Assistant", "Developer", "Researcher", "Planner"]) {
    await expect(page.getByText(bot, { exact: true })).toBeVisible();
  }
  step("Bots list shows the four seeded bots");
  // A bot with no chat yet opens the name sheet; Start chat without a name.
  await page.getByText("Assistant", { exact: true }).first().tap();
  await startChatFromSheet(page, "");
  step("chat opened from the list");
  await send(page, "e2e hello one");
  await expect(transcript(page).getByText("Got it.")).toBeVisible();
  await expect(transcript(page).getByText("e2e hello one")).toBeVisible();
  step("sent a message and got the fake reply");
  // Back to the list: the chat is a row with the reply as its preview; tapping it reopens the chat.
  await page.getByRole("link", { name: "Back to Bots" }).tap();
  const row = page.locator(`a[href^="/bots/${botId("Assistant")}/"]:not([href$="/edit"])`);
  await expect(row).toBeVisible();
  await row.filter({ visible: true }).first().tap();
  await expect(transcript(page).getByText("e2e hello one")).toBeVisible();
  step("chat is a list row and reopens with its history");
}

/** Every New chat button opens the name sheet; the name lands in the header and the bot's chat list. */
async function newChatNamed({ page, origin, step }) {
  await openBots(page, origin);
  await page.getByText("Researcher", { exact: true }).first().tap();
  await startChatFromSheet(page, "E2E named chat");
  await expect(page.getByText("E2E named chat")).toBeVisible();
  step("first chat started from the list with a name");
  await page.goto(`${origin}/bots/${botId("Researcher")}`, { waitUntil: "load" });
  await page.getByRole("button", { name: "New chat", exact: true }).tap();
  await startChatFromSheet(page, "E2E second chat");
  await expect(page.getByText("E2E second chat")).toBeVisible();
  step("second chat started from the bot's New chat button");
  await page.goto(`${origin}/bots/${botId("Researcher")}`, { waitUntil: "load" });
  await expect(page.getByText("E2E named chat")).toBeVisible();
  await expect(page.getByText("E2E second chat")).toBeVisible();
  step("both names are on the bot's chat list");
}

/** A bot delegates a task through the real MCP tool; the other bot's reply comes back as the result. */
async function delegateTask({ page, origin, step }) {
  await newChatOnBotScreen(page, origin, "Planner", "E2E delegator");
  const call = {
    targetBot: "Developer",
    title: "E2E delegated task",
    objective: "Reply with the word TASKDONE.",
  };
  await send(page, `MCPTOOL delegate_task ${JSON.stringify(call)}`);
  await expect(transcript(page).getByText(/MCPTOOL delegate_task ok/)).toBeVisible();
  step("the delegate_task tool accepted the task");
  // The result is handed back to the delegating bot's chat as a card.
  await expect(transcript(page).getByText("Developer finished: E2E delegated task")).toBeVisible({
    timeout: 25_000,
  });
  await expect(transcript(page).getByText("TASKDONE")).toBeVisible();
  step("the task's result reached the chat");
  await page.goto(`${origin}/tasks?view=completed`, { waitUntil: "load" });
  // The fake Planner re-delegates when it resumes, so its own task can carry the
  // same title; only check the Done tab lists it (the result is proven above).
  await expect(page.getByRole("link", { name: /E2E delegated task/ }).first()).toBeVisible();
  step("the Done tab lists the task");
}

/** Chats search: a message sent earlier is found from the list and opens its chat. */
async function chatsSearch({ page, origin, step }) {
  const needle = "quokkafinder4417";
  await newChatOnBotScreen(page, origin, "Researcher", "E2E search target");
  await send(page, `please remember ${needle}`);
  await expect(transcript(page).getByText("Got it.")).toBeVisible();
  step("sent a message with a unique word");
  await openBots(page, origin);
  const search = page.getByLabel("Search bots and chats");
  await search.tap();
  await search.fill(needle);
  await expect(page.getByText("In messages")).toBeVisible();
  const hit = page.locator(`a[href^="/bots/${botId("Researcher")}/"]`, { hasText: needle }).first();
  await expect(hit).toBeVisible();
  step("the message shows under In messages");
  await hit.tap();
  await expect(transcript(page).getByText(needle)).toBeVisible();
  step("tapping the hit opens the chat on that message");
}

/** Long-press a message, Reply, and the reply carries its quote. */
async function longPressReply({ page, context, origin, step }) {
  await newChatOnBotScreen(page, origin, "Assistant", "E2E reply");
  await send(page, "e2e reply target");
  const botMessage = transcript(page).locator("[data-message-id]", { hasText: "Got it." }).first();
  await expect(botMessage).toBeVisible();
  step("a bot message to reply to is on screen");
  await longPress(context, page, botMessage);
  await expect(page.getByRole("menuitem", { name: "Reply" })).toBeVisible();
  step("long press opened the message menu");
  await page.getByRole("menuitem", { name: "Reply" }).tap();
  await expect(page.getByRole("button", { name: "Cancel reply" })).toBeVisible();
  await composer(page).fill("e2e answer to the quote");
  await page.getByRole("button", { name: "Send", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Cancel reply" })).toBeHidden();
  // The sent message shows the quoted text above the new words.
  await expect
    .poll(async () => (await transcript(page).innerText()).replace(/\s+/g, " "))
    .toMatch(/You said: Assistant Got it\. e2e answer to the quote/);
  step("the reply was sent with its quote");
  await expect(transcript(page).getByText("Got it.")).toHaveCount(3, { timeout: 20_000 });
  step("the bot answered the reply");
}

/** Runs only when asked for by id (`-Journey selftest-fail`): proves a failing journey fails the gate and keeps its artifacts. */
export const SELFTEST_JOURNEYS = [
  {
    id: "selftest-fail",
    title: "Always fails",
    async run({ page, origin }) {
      await openBots(page, origin);
      await expect(page.getByText("This text is not on the Bots list")).toBeVisible({
        timeout: 1_500,
      });
    },
  },
];

export const JOURNEYS = [
  { id: "bots-list-chat", title: "Bots list, open a chat, send, fake reply", run: botsListChat },
  { id: "new-chat-named", title: "New chat with a name", run: newChatNamed },
  { id: "delegate-task", title: "Delegate a task and see its result", run: delegateTask },
  { id: "chats-search", title: "Chats search finds a message", run: chatsSearch },
  { id: "long-press-reply", title: "Long-press Reply on a message", run: longPressReply },
];
