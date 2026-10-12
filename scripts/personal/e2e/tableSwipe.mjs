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
// "The app took the touch" is watched with a MutationObserver on the row: the
// swipe writes the row's inline style (transform, transition, the time's opacity
// variable) and mounts the time element, so any write means useMessageSwipe
// claimed the gesture. That is the fix's contract and it is engine-independent:
// Chromium starts its own pan anyway (and cancels the pointer), so scrollLeft
// alone cannot tell the before build from the after one; the observer can.
// The watch and the scroll widths are read off a handle kept on window, so a
// row that has left the page still reports what happened.
//
// Headless Chromium has a touch overscroll gesture that iOS Safari does not:
// when a rightward drag has nothing left to consume, the browser sends the page
// back to the previous history entry itself (a popstate with no app call). This
// script detects that, records it on the check and goes forward again, so every
// check still runs; the drag's own numbers are read before the recovery.
//
// Exit code: 0 every check passed, 1 a check failed, 2 setup failed. The result
// JSON is written to <out>\table-swipe-<label>.json.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  loadPlaywright,
  newChatOnBotScreen,
  openBots,
  openPhone,
  pairContext,
  send,
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

const pathnameOf = (value) => new URL(value).pathname;

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
}

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
let pageRef;
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
  pageRef = page;
  // Harout's phone is the installed app; the edge swipe back only runs there.
  await context.addInitScript(() => {
    Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
  });
  const session = await context.newCDPSession(page);
  const navigations = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(pathnameOf(page.url()));
  });

  /** Watches one row for the swipe's own marks and keeps a handle on page. */
  const watchRow = (row, scrollerSelector) =>
    row.evaluate((element, selector) => {
      const watch = { styleWrites: 0, timeSeen: false };
      window.__swipeWatch = watch;
      window.__swipeRow = element;
      window.__swipeScroller = element.querySelector(selector);
      const styleObserver = new MutationObserver(() => {
        watch.styleWrites += 1;
      });
      styleObserver.observe(element, { attributes: true, attributeFilter: ["style"] });
      const timeObserver = new MutationObserver(() => {
        if (element.querySelector("[data-message-time]") !== null) watch.timeSeen = true;
      });
      timeObserver.observe(element, { childList: true, subtree: true });
      window.__swipeWatchStop = () => {
        styleObserver.disconnect();
        timeObserver.disconnect();
        return watch;
      };
    }, scrollerSelector);

  /** What the watched row shows, from the handle: it works after it has left the page. */
  const readWatch = () =>
    page.evaluate(() => {
      const watch = window.__swipeWatchStop ? window.__swipeWatchStop() : null;
      const scroller = window.__swipeScroller ?? null;
      const row = window.__swipeRow ?? null;
      return watch === null
        ? null
        : {
            styleWrites: watch.styleWrites,
            timeSeen: watch.timeSeen,
            scrollLeft: scroller === null ? null : Math.round(scroller.scrollLeft),
            scrollWidth: scroller === null ? null : scroller.scrollWidth,
            clientWidth: scroller === null ? null : scroller.clientWidth,
            rowTransform: row === null ? null : row.style.transform || "",
          };
    });

  /** The row's state while it is still on the page (for the mid-gesture sample). */
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

  /** Chromium's touch overscroll gesture (see the header): go back to the chat. */
  const browserBacks = [];
  const recoverIfLeftChat = async (expectedPath) => {
    if (pathnameOf(page.url()) === expectedPath) return false;
    browserBacks.push(pathnameOf(page.url()));
    await page.goForward().catch(() => undefined);
    await page
      .waitForFunction((path) => location.pathname === path, expectedPath, { timeout: 10_000 })
      .catch(() => undefined);
    await page.getByPlaceholder(/^Message/).waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(300);
    return true;
  };

  /** What is under a point: the touch must land on the message it is meant to test. */
  const hitAt = (point) =>
    page.evaluate(
      ({ x, y }) => {
        const target = document.elementFromPoint(x, y);
        if (target === null) return { tag: null, inRow: false, inScroller: false };
        return {
          tag: target.tagName,
          inRow: target.closest("[data-replyable]") !== null,
          inScroller:
            target.closest(
              '[data-slot="scroll-area-viewport"], .chat-markdown pre, [data-injected-scroller]',
            ) !== null,
        };
      },
      { x: point.x, y: point.y },
    );

  /** One drag on a row, watched: what the app did with the touch. */
  const dragWatched = async (row, scrollerSelector, from, to, options = {}) => {
    const hit = await hitAt(from);
    if (!hit.inRow) {
      throw new Error(
        `the drag from ${JSON.stringify(from)} missed the message (hit ${hit.tag ?? "nothing"})`,
      );
    }
    await watchRow(row, scrollerSelector);
    const during = await touchDrag(session, page, from, to, options);
    const after = await readWatch();
    const browserBack = await recoverIfLeftChat(options.expectedPath ?? pathnameOf(page.url()));
    return {
      during,
      after,
      hit,
      browserBack,
      appTookTouch: after !== null && (after.styleWrites > 0 || after.timeSeen),
    };
  };

  // A chat with the seeded Assistant: a long reply above so the transcript
  // scrolls, then the wide table. Started from the bot's own screen, so a bot
  // that already has chats opens a fresh one either way.
  await openBots(page, origin);
  await newChatOnBotScreen(page, origin, "Assistant", "");
  const chatPath = pathnameOf(page.url());
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

  /** The wide table's box, measured where it is now (a recovery may have moved it). */
  const wideBox = async () => {
    const box = await wideScroller.boundingBox();
    if (box === null) throw new Error("the wide table has no box");
    return box;
  };
  const wideY = (box) => box.y + Math.min(box.height / 2, 60);

  const start = await rowState(wideRow, '[data-slot="scroll-area-viewport"]');
  record("wide-table-overflows", (start.scrollWidth ?? 0) > (start.clientWidth ?? 0) + 1, {
    scrollWidth: start.scrollWidth,
    clientWidth: start.clientWidth,
    scrollLeft: start.scrollLeft,
  });

  // 1. A left drag pans the table; the message must not move and no time may appear.
  let box = await wideBox();
  const left = await dragWatched(
    wideRow,
    '[data-slot="scroll-area-viewport"]',
    mid(box.x + box.width - 30, wideY(box)),
    mid(box.x + 30, wideY(box)),
    {
      during: () => rowState(wideRow, '[data-slot="scroll-area-viewport"]'),
      expectedPath: chatPath,
    },
  );
  await page.screenshot({ path: NodePath.join(outDir, `table-swiped-left-${label}.png`) });
  record(
    "left-drag-pans-table",
    (left.after?.scrollLeft ?? 0) >= (start.scrollLeft ?? 0) + 40 && !left.appTookTouch,
    {
      scrollLeftBefore: start.scrollLeft,
      scrollLeftAfter: left.after?.scrollLeft ?? null,
      scrollWidth: start.scrollWidth,
      clientWidth: start.clientWidth,
      appTookTouch: left.appTookTouch,
      styleWrites: left.after?.styleWrites ?? null,
      timeSeen: left.after?.timeSeen ?? null,
      browserBack: left.browserBack,
    },
  );

  // 2. The bug: a right drag must pan it back. Before 1.66.32 the message's
  // swipe took the touch, the table stayed where it was and the time appeared.
  box = await wideBox();
  const right = await dragWatched(
    wideRow,
    '[data-slot="scroll-area-viewport"]',
    mid(box.x + 30, wideY(box)),
    mid(box.x + box.width - 30, wideY(box)),
    {
      during: () => rowState(wideRow, '[data-slot="scroll-area-viewport"]'),
      expectedPath: chatPath,
    },
  );
  await page.screenshot({ path: NodePath.join(outDir, `table-swiped-back-${label}.png`) });
  record(
    "right-drag-pans-table-back",
    (right.after?.scrollLeft ?? 99) <= (start.scrollLeft ?? 0) + 2 && !right.appTookTouch,
    {
      scrollLeftBefore: left.after?.scrollLeft ?? null,
      scrollLeftAfter: right.after?.scrollLeft ?? null,
      appTookTouch: right.appTookTouch,
      hitAtTouch: right.hit,
      styleWrites: right.after?.styleWrites ?? null,
      timeSeen: right.after?.timeSeen ?? null,
      duringTransform: right.during?.transform ?? null,
      duringTimeShown: right.during?.timeShown ?? null,
      browserBack: right.browserBack,
    },
  );

  // 3. Another right drag at the start: nothing left to pan, so nothing happens
  // at all (the message must not swipe either).
  box = await wideBox();
  const again = await dragWatched(
    wideRow,
    '[data-slot="scroll-area-viewport"]',
    mid(box.x + 30, wideY(box)),
    mid(box.x + box.width - 30, wideY(box)),
    {
      during: () => rowState(wideRow, '[data-slot="scroll-area-viewport"]'),
      expectedPath: chatPath,
    },
  );
  record("right-drag-at-start-stays-put", !again.appTookTouch, {
    appTookTouch: again.appTookTouch,
    hitAtTouch: again.hit,
    styleWrites: again.after?.styleWrites ?? null,
    timeSeen: again.after?.timeSeen ?? null,
    browserBack: again.browserBack,
  });

  // 4. The message's own swipe still works on the text beside the table. The
  // watch must see this one take the touch: that is what proves it can see the
  // swipe at all.
  const textBox = await wideRow.locator("p").first().boundingBox();
  if (textBox === null) throw new Error("the message text has no box");
  const textY = textBox.y + textBox.height / 2;
  const text = await dragWatched(
    wideRow,
    '[data-slot="scroll-area-viewport"]',
    mid(textBox.x + 20, textY),
    mid(textBox.x + 20 + 120, textY),
    {
      during: () => rowState(wideRow, '[data-slot="scroll-area-viewport"]'),
      expectedPath: chatPath,
    },
  );
  record(
    "message-text-still-swipes",
    text.appTookTouch && (text.during?.timeShown ?? false) && text.after?.rowTransform === "",
    {
      appTookTouch: text.appTookTouch,
      hitAtTouch: text.hit,
      styleWrites: text.after?.styleWrites ?? null,
      timeSeen: text.after?.timeSeen ?? null,
      duringTransform: text.during?.transform ?? null,
      duringTimeShown: text.during?.timeShown ?? null,
      transformAfterSettle: text.after?.rowTransform ?? null,
      browserBack: text.browserBack,
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
  const fit = await dragWatched(
    fitRow,
    '[data-slot="scroll-area-viewport"]',
    mid(fitBox.x + 20, fitBox.y + Math.min(fitBox.height / 2, 40)),
    mid(fitBox.x + 20 + 120, fitBox.y + Math.min(fitBox.height / 2, 40)),
    {
      during: () => rowState(fitRow, '[data-slot="scroll-area-viewport"]'),
      expectedPath: chatPath,
    },
  );
  record(
    "fitting-table-still-swipes",
    (fitStart.scrollWidth ?? 0) <= (fitStart.clientWidth ?? 0) + 1 &&
      fit.appTookTouch &&
      fit.after?.rowTransform === "",
    {
      scrollWidth: fitStart.scrollWidth,
      clientWidth: fitStart.clientWidth,
      appTookTouch: fit.appTookTouch,
      hitAtTouch: fit.hit,
      styleWrites: fit.after?.styleWrites ?? null,
      timeSeen: fit.after?.timeSeen ?? null,
      duringTimeShown: fit.during?.timeShown ?? null,
      transformAfterSettle: fit.after?.rowTransform ?? null,
      browserBack: fit.browserBack,
    },
  );

  // 6. A vertical drag that starts on the wide table still scrolls the chat.
  const beforeVertical = await wideRow.evaluate((element) => element.getBoundingClientRect().top);
  box = await wideBox();
  const vertical = await dragWatched(
    wideRow,
    '[data-slot="scroll-area-viewport"]',
    mid(box.x + box.width / 2, wideY(box)),
    mid(box.x + box.width / 2, wideY(box) + 150),
    {
      during: () => rowState(wideRow, '[data-slot="scroll-area-viewport"]'),
      expectedPath: chatPath,
    },
  );
  const afterVertical = await wideRow.evaluate((element) => element.getBoundingClientRect().top);
  record(
    "vertical-drag-scrolls-chat",
    afterVertical - beforeVertical > 20 && !vertical.appTookTouch,
    {
      rowTopBefore: Math.round(beforeVertical),
      rowTopAfter: Math.round(afterVertical),
      scrolledBy: Math.round(afterVertical - beforeVertical),
      appTookTouch: vertical.appTookTouch,
      styleWrites: vertical.after?.styleWrites ?? null,
      browserBack: vertical.browserBack,
    },
  );

  // 7. An unwrapped code block pans both ways too (WIDECODE). Word wrap is on
  // by default, and a wrapped code block never overflows: turn it off first,
  // the way the footer toggle does.
  await send(page, "WIDECODE");
  const codeRow = page.locator('[data-replyable]:has-text("A wide code block:")');
  const codeScroller = codeRow.locator(".chat-markdown-codeblock pre").first();
  await codeScroller.waitFor({ state: "visible", timeout: 30_000 });
  const codeBlock = codeRow.locator(".chat-markdown-codeblock").first();
  if ((await codeBlock.getAttribute("data-wrap")) === "true") {
    await codeRow.getByRole("button", { name: "Disable line wrap" }).first().tap();
    await page
      .waitForFunction(
        () =>
          document
            .querySelector(
              "[data-replyable]:has(.chat-markdown-codeblock) .chat-markdown-codeblock",
            )
            ?.getAttribute("data-wrap") === "false",
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => undefined);
  }
  await page.waitForTimeout(400);
  const codeStart = await rowState(codeRow, ".chat-markdown-codeblock pre");
  const codeBox = await codeScroller.boundingBox();
  if (codeBox === null) throw new Error("the wide code block has no box");
  const codeY = codeBox.y + Math.min(codeBox.height / 2, 40);
  const codeLeft = await dragWatched(
    codeRow,
    ".chat-markdown-codeblock pre",
    mid(codeBox.x + codeBox.width - 20, codeY),
    mid(codeBox.x + 20, codeY),
    { expectedPath: chatPath },
  );
  const codeRight = await dragWatched(
    codeRow,
    ".chat-markdown-codeblock pre",
    mid(codeBox.x + 20, codeY),
    mid(codeBox.x + codeBox.width - 20, codeY),
    { during: () => rowState(codeRow, ".chat-markdown-codeblock pre"), expectedPath: chatPath },
  );
  // A flick leaves momentum behind, so the return may need a second, shorter
  // drag to land at the start: what matters is that it gets there and that
  // neither drag is taken by the message.
  const codeAgain =
    (codeRight.after?.scrollLeft ?? 99) > 2
      ? await dragWatched(
          codeRow,
          ".chat-markdown-codeblock pre",
          mid(codeBox.x + 20, codeY),
          mid(codeBox.x + codeBox.width - 20, codeY),
          { expectedPath: chatPath },
        )
      : null;
  const codeHome = codeAgain?.after?.scrollLeft ?? codeRight.after?.scrollLeft ?? null;
  record(
    "code-block-pans-both-ways",
    (codeStart.scrollWidth ?? 0) > (codeStart.clientWidth ?? 0) + 1 &&
      (codeLeft.after?.scrollLeft ?? 0) >= (codeStart.scrollLeft ?? 0) + 40 &&
      (codeHome ?? 99) <= (codeStart.scrollLeft ?? 0) + 2 &&
      !codeLeft.appTookTouch &&
      !codeRight.appTookTouch &&
      !(codeAgain?.appTookTouch ?? false),
    {
      scrollWidth: codeStart.scrollWidth,
      clientWidth: codeStart.clientWidth,
      scrollLeftAfterLeft: codeLeft.after?.scrollLeft ?? null,
      scrollLeftAfterRight: codeRight.after?.scrollLeft ?? null,
      scrollLeftBackAtStart: codeHome,
      leftAppTookTouch: codeLeft.appTookTouch,
      rightAppTookTouch: codeRight.appTookTouch,
      againAppTookTouch: codeAgain?.appTookTouch ?? null,
      rightStyleWrites: codeRight.after?.styleWrites ?? null,
      rightTimeSeen: codeRight.after?.timeSeen ?? null,
      browserBack:
        codeLeft.browserBack || codeRight.browserBack || (codeAgain?.browserBack ?? false),
    },
  );

  // 8. The owner's side, instrumented: an owner bubble is plain wrapped text and
  // has no scroller of its own, so an overflowing box is put inside the owner's
  // row to drive the same rule (align "end" swipes leftwards) for real. It is
  // absolutely positioned so it takes no space and cannot move the bubble.
  const ownerRow = page.locator('[data-replyable]:has-text("TABLEMSG")');
  const injectOwnerScroller = async () => {
    await ownerRow.scrollIntoViewIfNeeded();
    await ownerRow.evaluate((element) => {
      element.querySelector("[data-injected-scroller]")?.remove();
      const scroller = document.createElement("div");
      scroller.setAttribute("data-injected-scroller", "");
      scroller.style.cssText =
        "position:absolute;left:0;top:0;width:120px;height:20px;overflow-x:auto";
      const inner = document.createElement("div");
      inner.style.cssText = "width:1200px;height:20px";
      scroller.appendChild(inner);
      element.appendChild(scroller);
    });
    const box = await ownerRow.locator("[data-injected-scroller]").boundingBox();
    if (box === null) throw new Error("the injected scroller has no box");
    return box;
  };
  let injectedBox = await injectOwnerScroller();
  const ownerLeft = await dragWatched(
    ownerRow,
    "[data-injected-scroller]",
    mid(injectedBox.x + injectedBox.width - 20, injectedBox.y + injectedBox.height / 2),
    mid(injectedBox.x + 20, injectedBox.y + injectedBox.height / 2),
    { expectedPath: chatPath },
  );
  const injectedAfterLeft = ownerLeft.after?.scrollLeft ?? null;
  if (ownerLeft.browserBack) injectedBox = await injectOwnerScroller();
  const ownerRight = await dragWatched(
    ownerRow,
    "[data-injected-scroller]",
    mid(injectedBox.x + 20, injectedBox.y + injectedBox.height / 2),
    mid(injectedBox.x + injectedBox.width - 20, injectedBox.y + injectedBox.height / 2),
    { during: () => rowState(ownerRow, "[data-injected-scroller]"), expectedPath: chatPath },
  );
  record(
    "owner-scroller-does-not-move-the-message",
    !ownerLeft.appTookTouch && !ownerRight.appTookTouch,
    {
      instrumented: true,
      injectedScrollerPans: (injectedAfterLeft ?? 0) > 40,
      scrollLeftAfterLeft: injectedAfterLeft,
      scrollLeftAfterRight: ownerRight.after?.scrollLeft ?? null,
      leftAppTookTouch: ownerLeft.appTookTouch,
      rightAppTookTouch: ownerRight.appTookTouch,
      hitAtTouch: ownerRight.hit,
      rightStyleWrites: ownerRight.after?.styleWrites ?? null,
      rightTimeSeen: ownerRight.after?.timeSeen ?? null,
      browserBack: ownerLeft.browserBack || ownerRight.browserBack,
    },
  );

  // 9. The owner's own message text still swipes left for its time.
  const ownerText = await ownerRow.locator("p").first().boundingBox();
  if (ownerText === null) throw new Error("the owner message has no box");
  const ownerTextY = ownerText.y + ownerText.height / 2;
  const ownerTextDrag = await dragWatched(
    ownerRow,
    "[data-injected-scroller]",
    mid(ownerText.x + ownerText.width - 10, ownerTextY),
    mid(ownerText.x + ownerText.width - 10 - 120, ownerTextY),
    { during: () => rowState(ownerRow, "[data-injected-scroller]"), expectedPath: chatPath },
  );
  record(
    "owner-text-still-swipes",
    ownerTextDrag.appTookTouch && (ownerTextDrag.during?.timeShown ?? false),
    {
      appTookTouch: ownerTextDrag.appTookTouch,
      hitAtTouch: ownerTextDrag.hit,
      styleWrites: ownerTextDrag.after?.styleWrites ?? null,
      timeSeen: ownerTextDrag.after?.timeSeen ?? null,
      duringTimeShown: ownerTextDrag.during?.timeShown ?? null,
      browserBack: ownerTextDrag.browserBack,
    },
  );
  await page.waitForTimeout(400);

  // 10. The 20 px edge strip: the swipe back still leaves the chat for the list.
  const chatBeforeEdge = pathnameOf(page.url());
  await touchDrag(session, page, mid(8, 500), mid(320, 500), { steps: 16, settleMs: 900 });
  await page
    .waitForFunction(() => new URL(location.href).pathname === "/bots", undefined, {
      timeout: 5_000,
    })
    .catch(() => undefined);
  const landed = pathnameOf(page.url());
  record("edge-swipe-back-still-works", landed === "/bots", { from: chatBeforeEdge, landed });

  const failed = checks.filter((check) => !check.ok);
  const result = {
    label,
    origin,
    when: new Date().toISOString(),
    standalone: true,
    checks,
    failed: failed.map((check) => check.name),
    browserBacks,
    navigations,
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
      browserBacks: browserBacks.length,
    })}`,
  );
  await context.close();
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error(`setup failed: ${error instanceof Error ? error.message : String(error)}`);
  const failed = checks.filter((check) => !check.ok);
  console.error(
    `after ${checks.length} checks (${failed.length} failed at: ${failed.map((check) => check.name).join(", ") || "none"}), page is at ${pageRef?.url() ?? "unknown"}`,
  );
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  process.exit(2);
}
