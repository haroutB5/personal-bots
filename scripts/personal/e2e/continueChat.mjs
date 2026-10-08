// 1.66.12: a lead hands work into a bot's existing chat. The fake CLI keeps what each provider session
// was told (WHATWORD answers with the codeword from an earlier prompt of the same session), so a reply
// that recalls the codeword proves the turn ran in the session of the owner's earlier conversation.
import { expect } from "./expect.mjs";
import { botId, composer, newChatOnBotScreen, openBots, send, transcript } from "./lib.mjs";

const textOf = (page) => transcript(page).innerText();

/** The Researcher's own chat: the owner tells it a codeword; the lead lists its chats, delegates into one, then steers. */
async function continueChat({ page, origin, step }) {
  // 1. A conversation between the owner and the Researcher, with a codeword in it.
  await newChatOnBotScreen(page, origin, "Researcher", "E2E review chat");
  await send(page, "The codeword is kiwi");
  await expect(transcript(page).getByText("Got it.")).toBeVisible();
  const researcherChatId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  step(`the Researcher has a chat (${researcherChatId}) that knows the codeword`);

  // 2. The Assistant lists the Researcher's chats and finds it.
  await newChatOnBotScreen(page, origin, "Assistant", "E2E continue lead");
  await send(page, `MCPONCE list_bot_chats ${JSON.stringify({ bot: "Researcher" })}`);
  await expect(transcript(page).getByText(/MCPTOOL list_bot_chats ok/)).toBeVisible();
  const listed = await textOf(page);
  if (!listed.includes(researcherChatId) || !listed.includes("E2E review chat")) {
    throw new Error(`list_bot_chats did not show the Researcher's chat: ${listed.slice(-600)}`);
  }
  step("list_bot_chats shows the chat with its id and title");

  // 3. Delegate into it: the Researcher answers in that chat, from its earlier conversation.
  const call = {
    targetBot: "Researcher",
    title: "E2E continue",
    objective: "WHATWORD",
    continueChatId: researcherChatId,
  };
  await send(page, `MCPONCE delegate_task ${JSON.stringify(call)}`);
  await expect(transcript(page).getByText(/MCPTOOL delegate_task ok/)).toBeVisible();
  await expect(transcript(page).getByText("Researcher finished: E2E continue")).toBeVisible({
    timeout: 40_000,
  });
  await expect(transcript(page).getByText("The codeword was kiwi.")).toBeVisible();
  step("the result reached the lead and says the Researcher remembered the codeword");
  // The tool result is JSON inside the fake's JSON line, so its quotes arrive escaped.
  const taskId = /childTaskId\\*":\\*"([0-9a-f-]{36})/.exec(await textOf(page))?.[1];
  if (taskId === undefined) throw new Error("the delegate_task result carried no task id");

  // 4. The Researcher's chat: still the owner's chat, same name, with the lead's brief and the answer in it.
  await page.goto(`${origin}/bots/${botId("Researcher")}/${researcherChatId}`, {
    waitUntil: "load",
  });
  await expect(composer(page)).toBeVisible();
  await expect(transcript(page).getByText("The codeword is kiwi")).toBeVisible();
  await expect(transcript(page).getByText(/Task from Assistant: E2E continue/)).toBeVisible();
  await expect(transcript(page).getByText("The codeword was kiwi.")).toBeVisible();
  await expect(page.getByText("E2E review chat").first()).toBeVisible();
  step(
    "the brief shows as the Assistant's and the answer is in the owner's chat, under its own name",
  );
  await page.goto(`${origin}/bots/${botId("Researcher")}`, { waitUntil: "load" });
  await expect(page.getByText("E2E review chat").first()).toBeVisible();
  await expect(page.getByText("E2E continue", { exact: true })).toHaveCount(0);
  step("no extra task chat was made on the Researcher's chat list");

  // 5. steer_task reopens it in the same chat; the Researcher still has the conversation.
  await page.goto(`${origin}/bots/${botId("Assistant")}`, { waitUntil: "load" });
  await page.getByText("E2E continue lead").first().tap();
  await composer(page).waitFor({ state: "visible" });
  const before = (await textOf(page)).split("Researcher finished: E2E continue").length - 1;
  await send(
    page,
    `MCPONCE steer_task ${JSON.stringify({ taskId, message: "WHATWORD once more" })}`,
  );
  await expect(transcript(page).getByText(/MCPTOOL steer_task ok/)).toBeVisible();
  await expect
    .poll(async () => (await textOf(page)).split("Researcher finished: E2E continue").length - 1, {
      timeout: 40_000,
    })
    .toBe(before + 1);
  step("steer_task reopened the task and its new result came back to the lead");
  await page.goto(`${origin}/bots/${botId("Researcher")}/${researcherChatId}`, {
    waitUntil: "load",
  });
  await expect
    .poll(async () => (await textOf(page)).split("The codeword was kiwi.").length - 1, {
      timeout: 15_000,
    })
    .toBe(2);
  step("the reopened task answered in the same chat, with the conversation still in its session");

  // 6. Controls: the same objective without the chat starts from nothing; another bot's chat is refused.
  await page.goto(`${origin}/bots/${botId("Assistant")}`, { waitUntil: "load" });
  await page.getByText("E2E continue lead").first().tap();
  await composer(page).waitFor({ state: "visible" });
  const leadChatId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  await send(
    page,
    `MCPONCE delegate_task ${JSON.stringify({ targetBot: "Researcher", title: "E2E plain", objective: "WHATWORD" })}`,
  );
  await expect(transcript(page).getByText("Researcher finished: E2E plain")).toBeVisible({
    timeout: 40_000,
  });
  await expect(transcript(page).getByText("I have no codeword in this session.")).toBeVisible();
  step("without continueChatId the Researcher starts from nothing and has no codeword");
  await send(
    page,
    `MCPONCE delegate_task ${JSON.stringify({ targetBot: "Researcher", title: "E2E wrong chat", objective: "WHATWORD", continueChatId: leadChatId })}`,
  );
  await expect(transcript(page).getByText(/MCPTOOL delegate_task refused/)).toBeVisible();
  await expect(
    transcript(page).getByText(/not a chat of the bot you are delegating to/),
  ).toBeVisible();
  step("another bot's chat is refused with its reason");
}

export const CONTINUE_JOURNEYS = [
  {
    id: "continue-chat",
    title: "A lead lists a bot's chats and continues one, then steers it",
    limitMs: 120_000,
    run: continueChat,
  },
];
