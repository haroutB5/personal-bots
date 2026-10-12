// Sideways-scroll checks for a message that holds a wide table or code block
// (1.66.32): a table swiped left must be swiped back right by the table's own
// pan, not swallowed by the message's swipe-to-see-the-time.
//
//   node tableSwipe.mjs --url <origin> --pair <pairing link> --bin <dist\bin.mjs> --out <dir> [--label <name>]
//
// Real touch drags (CDP Input.dispatchTouchEvent) on a 390x844 dark phone,
// standalone mode (the edge swipe back is only on in the installed app), against
// one throwaway server. Checks: the wide table pans both ways with the message
// never moving and no time appearing; the message's own swipe still works on the
// text and on a table that fits; a vertical drag on the table still scrolls the
// chat; a wide code block pans both ways too; the owner's side (an injected
// scroller, since the owner's bubble is plain wrapped text) does not move; the
// 20 px edge strip still drags the chat back to the Bots list.
//
// Exit code: 0 every check passed, 1 a check failed, 2 setup failed. The result
// JSON is written to <out>\table-swipe-<label>.json.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  loadPlaywright,
  openBots,
  openPhone,
  pairContext,
  send,
  startChatFromSheet,
  transcript,
} from "./lib.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const origin = args.url?.replace(/\/$/, "");
if (!origin || !args.pair || !args.out) {
  console.error(
    "usage: tableSwipe.mjs --url <origin> --pair <pairing link> --out <dir> [--bin <bin.mjs>] [--label <name>]",
  );
  process.exit(2);
}
const label = args.label ?? "run";
const outDir = args.out;
NodeFS.mkdirSync(outDir, { recursive: true });

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
}

/** The row's own state: the swipe writes its transform and draws the time itself. */
const rowState = (row, scrollerSelector) =>
  row.evaluate((element, selector) => {
    const scroller = element.querySelector(selector);
    const time = element.querySelector("[data-message-time]");
    const transform = element.style.transform || "";
    return {
      moved: transform !== "",
      transform,
      timeShown: time !== null && Number.parseFloat(getComputedStyle(time).opacity) > 0,
      scrollLeft: scroller === null ? null : Math.round(scroller.scrollLeft),
      scrollWidth: scroller === null ? null : scroller.scrollWidth,
      clientWidth: scroller === null ? null : scroller.clientWidth,
    };
  }, scrollerSelector);

/** A touch drag as the phone's finger: down, moves 18 ms apart, up. */
async function touchDrag(
  session,
  page,
  from,
  to,
  { steps = 12, during = null, settleMs = 500 } = {},
) {
  let duringState = null;
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y }],
  });
  for (let step = 1; step <= steps; step += 1) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * step) / steps,
          y: from.y + ((to.y - from.y) * step) / steps,
        },
      ],
    });
    await page.waitForTimeout(18);
  }
  if (during !== null) duringState = await during();
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(settleMs);
  return duringState;
}

const mid = (x, y) => ({ x, y });

let browser;
let context;
try {
  const playwright = loadPlaywright(args.bin);
  browser = await playwright.chromium.launch({
    channel: process.env.E2E_BROWSER_CHANNEL ?? "chrome",
    headless: process.env.E2E_HEADLESS !== "0",
  });
  const storageState = await pairContext(browser, origin, args.pair);
  const phone = await openPhone(browser, origin, storageState);
  context = phone.context;
  const { page, errors } = phone;
  // Harout's phone is the installed app; the edge swipe back only runs there.
  await context.addInitScript(() => {
    Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
  });
  const session = await context.newCDPSession(page);

  // A chat with the seeded Assistant: a long reply above so the transcript
  // scrolls, then the wide table.
  await openBots(page, origin);
  await page.getByText("Assistant", { exact: true }).first().tap();
  await startChatFromSheet(page, "");
  await send(page, "LONGMSG");
  await transcript(page)
    .getByText("End of the long report.")
    .last()
    .waitFor({ state: "visible", timeout: 30_000 });
  await send(page, "TABLEMSG");
  const wideRow = page.locator('[data-replyable]:has-text("Here is the table you asked for.")');
  const wideScroller = wideRow.locator('[data-slot="scroll-area-viewport"]');
  await wideScroller.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(400);

  const tableBox = await wideScroller.boundingBox();
  if (tableBox === null) throw new Error("the wide table has no box");
  const tableY = tableBox.y + Math.min(tableBox.height / 2, 60);

  const start = await rowState(wideRow, '[data-slot="scroll-area-viewport"]');
  record("wide-table-overflows", (start.scrollWidth ?? 0) > (start.clientWidth ?? 0) + 1, {
    scrollWidth: start.scrollWidth,
    clientWidth: start.clientWidth,
    scrollLeft: start.scrollLeft,
  });

  // 1. A left drag pans the table; the message must not move and no time may appear.
  const leftDuring = await touchDrag(
    session,
    page,
    mid(tableBox.x + tableBox.width - 30, tableY),
    mid(tableBox.x + 30, tableY),
    {
      during: () => rowState(wideRow, '[data-slot="scroll-area-viewport"]'),
    },
  );
  const afterLeft = await rowState(wideRow, '[data-slot="scroll-area-viewport"]');
  await page.screenshot({ path: NodePath.join(outDir, `table-swiped-left-${label}.png`) });
  record("left-drag-pans-table", (afterLeft.scrollLeft ?? 0) >= (start.scrollLeft ?? 0) + 40, {
    scrollLeft: afterLeft.scrollLeft,
    duringMoved: leftDuring?.moved ?? null,
    duringTimeShown: leftDuring?.timeShown ?? null,
  });

  // 2. The bug: a right drag must pan it back. Before 1.66.32 the message's
  // swipe took the touch, the table stayed where it was and the time appeared.
  const rightDuring = await touchDrag(
    session,
    page,
    mid(tableBox.x + 30, tableY),
    mid(tableBox.x + tableBox.width - 30, tableY),
    {
      during: () => rowState(wideRow, '[data-slot="scroll-area-viewport"]'),
    },
  );
  const afterRight = await rowState(wideRow, '[data-slot="scroll-area-viewport"]');
  await page.screenshot({ path: NodePath.join(outDir, `table-swiped-back-${label}.png`) });
  record(
    "right-drag-pans-table-back",
    (afterRight.scrollLeft ?? 99) <= (start.scrollLeft ?? 0) + 2 &&
      rightDuring !== null &&
      !rightDuring.moved &&
      !rightDuring.timeShown,
    {
      scrollLeft: afterRight.scrollLeft,
      duringMoved: rightDuring?.moved ?? null,
      duringTransform: rightDuring?.transform ?? null,
      duringTimeShown: rightDuring?.timeShown ?? null,
    },
  );

  // 3. Another right drag at the start: nothing left to pan, so nothing happens
  // at all (the message must not swipe either).
  const againDuring = await touchDrag(
    session,
    page,
    mid(tableBox.x + 30, tableY),
    mid(tableBox.x + tableBox.width - 30, tableY),
    {
      during: () => rowState(wideRow, '[data-slot="scroll-area-viewport"]'),
    },
  );
  record(
    "right-drag-at-start-stays-put",
    againDuring !== null && !againDuring.moved && !againDuring.timeShown,
    {
      duringMoved: againDuring?.moved ?? null,
      duringTimeShown: againDuring?.timeShown ?? null,
      scrollLeft: againDuring?.scrollLeft ?? null,
    },
  );

  // 4. The message's own swipe still works on the text beside the table.
  const textBox = await wideRow.locator("p").first().boundingBox();
  if (textBox === null) throw new Error("the message text has no box");
  const textY = textBox.y + textBox.height / 2;
  const textDuring = await touchDrag(
    session,
    page,
    mid(textBox.x + 20, textY),
    mid(textBox.x + 20 + 120, textY),
    {
      during: () => rowState(wideRow, '[data-slot="scroll-area-viewport"]'),
    },
  );
  const textAfter = await rowState(wideRow, '[data-slot="scroll-area-viewport"]');
  record(
    "message-text-still-swipes",
    textDuring !== null && textDuring.moved && textDuring.timeShown && !textAfter.moved,
    {
      duringMoved: textDuring?.moved ?? null,
      duringTransform: textDuring?.transform ?? null,
      duringTimeShown: textDuring?.timeShown ?? null,
      afterMoved: textAfter.moved,
    },
  );

  // 5. A table that fits the screen does not block the swipe (TABLEFIT).
  await send(page, "TABLEFIT");
  const fitRow = page.locator('[data-replyable]:has-text("A small one.")');
  const fitScroller = fitRow.locator('[data-slot="scroll-area-viewport"]');
  await fitScroller.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(400);
  const fitBox = await fitScroller.boundingBox();
  if (fitBox === null) throw new Error("the fitting table has no box");
  const fitStart = await rowState(fitRow, '[data-slot="scroll-area-viewport"]');
  const fitDuring = await touchDrag(
    session,
    page,
    mid(fitBox.x + 20, fitBox.y + Math.min(fitBox.height / 2, 40)),
    mid(fitBox.x + 20 + 120, fitBox.y + Math.min(fitBox.height / 2, 40)),
    {
      during: () => rowState(fitRow, '[data-slot="scroll-area-viewport"]'),
    },
  );
  const fitAfter = await rowState(fitRow, '[data-slot="scroll-area-viewport"]');
  record(
    "fitting-table-still-swipes",
    (fitStart.scrollWidth ?? 0) <= (fitStart.clientWidth ?? 0) + 1 &&
      fitDuring !== null &&
      fitDuring.moved &&
      fitDuring.timeShown &&
      !fitAfter.moved,
    {
      scrollWidth: fitStart.scrollWidth,
      clientWidth: fitStart.clientWidth,
      duringMoved: fitDuring?.moved ?? null,
      duringTimeShown: fitDuring?.timeShown ?? null,
    },
  );

  // 6. A vertical drag that starts on the wide table still scrolls the chat.
  const beforeVertical = await wideRow.evaluate((element) => element.getBoundingClientRect().top);
  const verticalDuring = await touchDrag(
    session,
    page,
    mid(tableBox.x + tableBox.width / 2, tableY),
    mid(tableBox.x + tableBox.width / 2, tableY + 150),
    {
      during: () => rowState(wideRow, '[data-slot="scroll-area-viewport"]'),
    },
  );
  const afterVertical = await wideRow.evaluate((element) => element.getBoundingClientRect().top);
  record("vertical-drag-scrolls-chat", afterVertical - beforeVertical > 20, {
    rowTopBefore: Math.round(beforeVertical),
    rowTopAfter: Math.round(afterVertical),
    moved: afterVertical - beforeVertical,
    duringMoved: verticalDuring?.moved ?? null,
  });

  // 7. An unwrapped code block pans both ways too (WIDECODE).
  await send(page, "WIDECODE");
  const codeRow = page.locator('[data-replyable]:has-text("A wide code block:")');
  const codeScroller = codeRow.locator(".chat-markdown-codeblock pre").first();
  await codeScroller.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(400);
  const codeStart = await rowState(codeRow, ".chat-markdown-codeblock pre");
  const codeBox = await codeScroller.boundingBox();
  if (codeBox === null) throw new Error("the wide code block has no box");
  const codeY = codeBox.y + Math.min(codeBox.height / 2, 40);
  await touchDrag(
    session,
    page,
    mid(codeBox.x + codeBox.width - 20, codeY),
    mid(codeBox.x + 20, codeY),
  );
  const codeAfterLeft = await rowState(codeRow, ".chat-markdown-codeblock pre");
  const codeDuringRight = await touchDrag(
    session,
    page,
    mid(codeBox.x + 20, codeY),
    mid(codeBox.x + codeBox.width - 20, codeY),
    {
      during: () => rowState(codeRow, ".chat-markdown-codeblock pre"),
    },
  );
  const codeAfterRight = await rowState(codeRow, ".chat-markdown-codeblock pre");
  record(
    "code-block-pans-both-ways",
    (codeStart.scrollWidth ?? 0) > (codeStart.clientWidth ?? 0) + 1 &&
      (codeAfterLeft.scrollLeft ?? 0) >= (codeStart.scrollLeft ?? 0) + 40 &&
      (codeAfterRight.scrollLeft ?? 99) <= (codeStart.scrollLeft ?? 0) + 2 &&
      codeDuringRight !== null &&
      !codeDuringRight.moved &&
      !codeDuringRight.timeShown,
    {
      scrollWidth: codeStart.scrollWidth,
      clientWidth: codeStart.clientWidth,
      afterLeftScrollLeft: codeAfterLeft.scrollLeft,
      afterRightScrollLeft: codeAfterRight.scrollLeft,
      duringMoved: codeDuringRight?.moved ?? null,
      duringTimeShown: codeDuringRight?.timeShown ?? null,
    },
  );

  // 8. The owner's side, instrumented: an owner bubble is plain wrapped text and
  // has no scroller of its own, so an overflowing box is put inside the owner's
  // row to drive the same rule (align "end" swipes leftwards) for real.
  const ownerRow = page.locator('[data-replyable]:has-text("TABLEMSG")');
  await ownerRow.evaluate((element) => {
    const scroller = document.createElement("div");
    scroller.setAttribute("data-injected-scroller", "");
    scroller.style.cssText = "overflow-x:auto;width:100%;max-width:100%";
    const inner = document.createElement("div");
    inner.style.cssText = "width:1200px;height:36px";
    scroller.appendChild(inner);
    element.appendChild(scroller);
  });
  const injected = ownerRow.locator("[data-injected-scroller]");
  const injectedBox = await injected.boundingBox();
  if (injectedBox === null) throw new Error("the injected scroller has no box");
  const injectedY = injectedBox.y + injectedBox.height / 2;
  await touchDrag(
    session,
    page,
    mid(injectedBox.x + injectedBox.width - 20, injectedY),
    mid(injectedBox.x + 20, injectedY),
  );
  const injectedAfterLeft = await injected.evaluate((element) => Math.round(element.scrollLeft));
  const ownerDuringRight = await touchDrag(
    session,
    page,
    mid(injectedBox.x + 20, injectedY),
    mid(injectedBox.x + injectedBox.width - 20, injectedY),
    {
      during: () => rowState(ownerRow, "[data-injected-scroller]"),
    },
  );
  const injectedAfterRight = await injected.evaluate((element) => Math.round(element.scrollLeft));
  record(
    "owner-scroller-does-not-move-the-message",
    ownerDuringRight !== null && !ownerDuringRight.moved && !ownerDuringRight.timeShown,
    {
      instrumented: true,
      injectedScrollLeftAfterLeft: injectedAfterLeft,
      injectedScrollLeftAfterRight: injectedAfterRight,
      duringMoved: ownerDuringRight?.moved ?? null,
      duringTransform: ownerDuringRight?.transform ?? null,
      duringTimeShown: ownerDuringRight?.timeShown ?? null,
    },
  );

  // 9. The owner's own message text still swipes left for its time.
  const ownerText = await ownerRow.locator("p").first().boundingBox();
  if (ownerText === null) throw new Error("the owner message has no box");
  const ownerTextY = ownerText.y + ownerText.height / 2;
  const ownerTextDuring = await touchDrag(
    session,
    page,
    mid(ownerText.x + ownerText.width - 10, ownerTextY),
    mid(ownerText.x + ownerText.width - 10 - 120, ownerTextY),
    {
      during: () => rowState(ownerRow, "[data-injected-scroller]"),
    },
  );
  record(
    "owner-text-still-swipes",
    ownerTextDuring !== null && ownerTextDuring.moved && ownerTextDuring.timeShown,
    {
      duringMoved: ownerTextDuring?.moved ?? null,
      duringTransform: ownerTextDuring?.transform ?? null,
      duringTimeShown: ownerTextDuring?.timeShown ?? null,
    },
  );
  await page.waitForTimeout(400);

  // 10. The 20 px edge strip: the swipe back still leaves the chat for the list.
  const chatUrl = page.url();
  await touchDrag(session, page, mid(8, 500), mid(320, 500), { steps: 16, settleMs: 900 });
  await page
    .waitForURL((url) => new URL(url).pathname === "/bots", { timeout: 5_000 })
    .catch(() => undefined);
  const landed = new URL(page.url()).pathname;
  record("edge-swipe-back-still-works", landed === "/bots", { from: chatUrl, landed });

  const failed = checks.filter((check) => !check.ok);
  const result = {
    label,
    origin,
    when: new Date().toISOString(),
    standalone: true,
    checks,
    failed: failed.map((check) => check.name),
    pageErrors: errors,
  };
  NodeFS.writeFileSync(
    NodePath.join(outDir, `table-swipe-${label}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(
    `RESULT ${JSON.stringify({
      label,
      passed: checks.length - failed.length,
      total: checks.length,
      failed: failed.map((check) => check.name),
    })}`,
  );
  await context.close();
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error(`setup failed: ${error instanceof Error ? error.message : String(error)}`);
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  process.exit(2);
}
