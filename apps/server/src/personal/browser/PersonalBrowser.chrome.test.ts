// @effect-diagnostics nodeBuiltinImport:off - a throwaway local web server and the installed Chrome's path.
// @effect-diagnostics globalTimers:off - real Chrome needs real time.
/**
 * 1.66.6, proved in a real Chrome: the new bot browser actions run end to end
 * (tool request, lease, guards, driver, page) against a small local fixture
 * page in a headless Chrome with a throwaway profile folder. Never the shared
 * browser and never a profile signed into anything.
 *
 * Skipped where Chrome is not installed, and with PB_SKIP_REAL_CHROME=1.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PersonalTaskId,
  ThreadId,
  type PersonalTask,
  type PreviewAutomationRequest,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalLoginRepository from "../secrets/PersonalLoginRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as BrowserLease from "./BrowserLease.ts";
import { makePlaywrightDriver } from "./driver.ts";
import * as PersonalBrowser from "./PersonalBrowser.ts";
import * as PersonalBrowserLeaseRepository from "./PersonalBrowserLeaseRepository.ts";
import * as PersonalBrowserProtectionRepository from "./PersonalBrowserProtectionRepository.ts";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const chromeAvailable = NodeFS.existsSync(CHROME) && process.env.PB_SKIP_REAL_CHROME !== "1";

const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>fixture</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  .box { position: absolute; box-sizing: border-box; border: 1px solid #333; padding: 4px; }
  #dbl { left: 10px; top: 10px; width: 120px; height: 60px; }
  #ctx { left: 150px; top: 10px; width: 120px; height: 60px; }
  #ctrl { left: 290px; top: 10px; width: 120px; height: 60px; }
  #hov { left: 10px; top: 90px; width: 120px; height: 40px; }
  #menu { display: none; left: 10px; top: 130px; width: 120px; height: 30px; background: #ffe; }
  #hov:hover + #menu { display: block; }
  #src { left: 10px; top: 220px; width: 100px; height: 50px; background: #cde; }
  #dst { left: 200px; top: 220px; width: 120px; height: 50px; background: #edc; }
  #knob { position: absolute; left: 10px; top: 300px; width: 30px; height: 30px; background: #393; }
  #log { position: absolute; left: 10px; top: 360px; }
</style></head><body>
<div id="dbl" class="box">double</div>
<div id="ctx" class="box">context</div>
<a id="ctrl" class="box" href="/second">ctrl link</a>
<div id="hov" class="box">hover me</div>
<div id="menu" class="box"><span id="menu-item">Menu item</span></div>
<div id="src" class="box" draggable="true">drag me</div>
<div id="dst" class="box">drop here</div>
<div id="knob"></div>
<div id="log"></div>
<script>
  window.__events = [];
  const log = (text) => { window.__events.push(text); document.getElementById('log').textContent = window.__events.join(' | '); };
  const $ = (id) => document.getElementById(id);
  $('dbl').addEventListener('dblclick', (e) => log('dblclick:' + e.button + ':' + e.detail));
  $('ctx').addEventListener('contextmenu', (e) => { e.preventDefault(); log('contextmenu'); });
  $('ctx').addEventListener('mousedown', (e) => log('mousedown:' + e.button));
  $('ctrl').addEventListener('click', (e) => { e.preventDefault(); log('click:ctrl=' + e.ctrlKey + ':shift=' + e.shiftKey + ':alt=' + e.altKey); });
  $('ctrl').addEventListener('auxclick', (e) => { e.preventDefault(); log('auxclick:' + e.button); });
  $('hov').addEventListener('mouseenter', () => log('hover'));
  $('src').addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'card-1'); log('dragstart'); });
  $('dst').addEventListener('dragover', (e) => e.preventDefault());
  $('dst').addEventListener('drop', (e) => { e.preventDefault(); log('drop:' + e.dataTransfer.getData('text/plain')); });
  let held = false, moved = false;
  $('knob').addEventListener('mousedown', () => { held = true; moved = false; log('knob:down'); });
  document.addEventListener('mousemove', (e) => { if (!held) return; $('knob').style.left = (e.clientX - 15) + 'px'; if (!moved) { moved = true; log('knob:moved'); } });
  document.addEventListener('mouseup', () => { if (held) { held = false; log('knob:up'); } });
</script></body></html>`;

const taskService = Layer.mock(PersonalTaskService.PersonalTaskService)({
  rootTaskIdForThread: () => Effect.succeed(Option.none<ReturnType<typeof PersonalTaskId.make>>()),
  list: () => Effect.succeed({ tasks: [] }),
  waitForBrowser: () => Effect.succeed({} as PersonalTask),
  resumeFromUser: () => Effect.succeed({} as PersonalTask),
});

/** The real browser service over the real Playwright driver and a temporary profile folder. */
const realChromeLayer = PersonalBrowser.makeLayer({
  driver: makePlaywrightDriver(),
  headless: true,
  executablePath: undefined,
}).pipe(
  Layer.provideMerge(BrowserLease.layer),
  Layer.provideMerge(PersonalBrowserLeaseRepository.layer),
  Layer.provideMerge(PersonalBrowserProtectionRepository.layer),
  Layer.provideMerge(PersonalBotRepository.layer),
  Layer.provideMerge(PersonalLoginRepository.layer),
  Layer.provideMerge(taskService),
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-chrome-" })),
  Layer.provideMerge(NodeServices.layer),
);

const threadId = ThreadId.make("thread-chrome");
let sequence = 0;
const request = (
  operation: PreviewAutomationRequest["operation"],
  input: unknown = {},
  extra: Partial<PreviewAutomationRequest> = {},
): PreviewAutomationRequest => ({
  requestId: `chrome-${sequence++}`,
  threadId,
  operation,
  input,
  timeoutMs: 30_000,
  ...extra,
});

const startFixtureServer = () =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          readonly server: NodeHttp.Server;
          readonly origin: string;
          hits: Map<string, number>;
        }>((resolve) => {
          const hits = new Map<string, number>();
          const server = NodeHttp.createServer((req, res) => {
            const path = new URL(req.url ?? "/", "http://fixture").pathname;
            hits.set(path, (hits.get(path) ?? 0) + 1);
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            if (path === "/") res.end(FIXTURE);
            else
              res.end(
                `<!doctype html><title>${path}</title><body>page ${path} hit ${hits.get(path)}</body>`,
              );
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            resolve({ server, origin: `http://127.0.0.1:${port}`, hits });
          });
        }),
    ),
    ({ server }) =>
      Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

describe.skipIf(!chromeAvailable)("bot browser actions in a real Chrome (1.66.6)", () => {
  it.live(
    "double-click, right-click, ctrl-click, hover, drag and drop, history and closing one tab",
    () =>
      Effect.gen(function* () {
        const { origin, hits } = yield* startFixtureServer();
        const browser = yield* PersonalBrowser.PersonalBrowser;
        yield* Effect.addFinalizer(() =>
          browser.closeBrowser({ sessionId: "chrome-test", byThreadId: null }).pipe(Effect.ignore),
        );
        const events = () =>
          browser
            .handleAutomationRequest(request("evaluate", { expression: "window.__events.slice()" }))
            .pipe(Effect.map((value) => value as string[]));
        const run = (operation: PreviewAutomationRequest) =>
          browser.handleAutomationRequest(operation);

        const first = (yield* run(
          request("navigate", { url: `${origin}/` }),
        )) as PreviewAutomationStatus;
        expect(first.url).toBe(`${origin}/`);

        // Double click, by locator and by point: a real dblclick event with detail 2.
        yield* run(request("click", { locator: "#dbl", clicks: 2 }));
        yield* run(request("click", { x: 70, y: 40, clicks: 2 }));
        expect((yield* events()).filter((entry) => entry === "dblclick:0:2")).toHaveLength(2);

        // Right click: the page's contextmenu event, by locator and by point.
        yield* run(request("click", { locator: "#ctx", button: "right" }));
        yield* run(request("click", { x: 210, y: 40, button: "right" }));
        const afterRight = yield* events();
        expect(afterRight.filter((entry) => entry === "contextmenu")).toHaveLength(2);
        expect(afterRight.filter((entry) => entry === "mousedown:2")).toHaveLength(2);

        // Ctrl-click (with shift) and middle click on the link; by locator and by point.
        yield* run(request("click", { locator: "#ctrl", modifiers: ["Control"] }));
        yield* run(request("click", { x: 350, y: 40, modifiers: ["Control", "Shift"] }));
        yield* run(request("click", { x: 350, y: 40, button: "middle" }));
        const afterCtrl = yield* events();
        expect(afterCtrl).toContain("click:ctrl=true:shift=false:alt=false");
        expect(afterCtrl).toContain("click:ctrl=true:shift=true:alt=false");
        expect(afterCtrl).toContain("auxclick:1");
        // The keys were let go again: a plain click afterwards carries none.
        yield* run(request("click", { x: 350, y: 40 }));
        expect((yield* events()).at(-1)).toBe("click:ctrl=false:shift=false:alt=false");

        // Hover opens the menu that only :hover shows, by locator and by point.
        const menuVisible = () =>
          browser
            .handleAutomationRequest(
              request("evaluate", {
                expression: "getComputedStyle(document.getElementById('menu')).display",
              }),
            )
            .pipe(Effect.map((value) => value as string));
        expect(yield* menuVisible()).toBe("none");
        yield* run(request("hover", { locator: "#hov" }));
        expect(yield* menuVisible()).toBe("block");
        yield* run(request("hover", { x: 300, y: 200 }));
        expect(yield* menuVisible()).toBe("none");
        yield* run(request("hover", { x: 70, y: 110 }));
        expect(yield* menuVisible()).toBe("block");
        expect(
          (yield* events()).filter((entry) => entry === "hover").length,
        ).toBeGreaterThanOrEqual(2);

        // Drag and drop (HTML5), locator to locator and point to point.
        yield* run(request("drag", { fromLocator: "#src", toLocator: "#dst" }));
        yield* run(request("drag", { fromX: 60, fromY: 245, toX: 260, toY: 245 }));
        const afterDrop = yield* events();
        expect(afterDrop.filter((entry) => entry === "drop:card-1")).toHaveLength(2);

        // A mouse-driven drag: down, moves, up, and the button is up afterwards.
        yield* run(request("drag", { fromX: 25, fromY: 315, toX: 205, toY: 315 }));
        const afterKnob = yield* events();
        expect(afterKnob.slice(-3)).toEqual(["knob:down", "knob:moved", "knob:up"]);
        const knobLeft = (yield* run(
          request("evaluate", { expression: "document.getElementById('knob').style.left" }),
        )) as string;
        expect(knobLeft).toBe("190px");

        // Back, forward and reload.
        yield* run(request("navigate", { url: `${origin}/second` }));
        const back = (yield* run(
          request("history", { action: "back" }),
        )) as PreviewAutomationStatus;
        expect(back.url).toBe(`${origin}/`);
        const forward = (yield* run(
          request("history", { action: "forward" }),
        )) as PreviewAutomationStatus;
        expect(forward.url).toBe(`${origin}/second`);
        const before = hits.get("/second") ?? 0;
        yield* run(request("history", { action: "reload" }));
        expect(hits.get("/second")).toBe(before + 1);
        const nothing = yield* run(request("history", { action: "forward" })).pipe(Effect.flip);
        expect(nothing.message).toContain("no later page");

        // Closing one tab leaves the other.
        const second = (yield* run(
          request("open", { url: `${origin}/third`, reuseExistingTab: false }),
        )) as PreviewAutomationStatus;
        expect(second.tabId).not.toBe(first.tabId);
        const closed = (yield* run(
          request("closeTab", {}, { tabId: first.tabId!, tabIdExplicit: true }),
        )) as { closedTabId: string; remainingTabIds: string[] };
        expect(closed.closedTabId).toBe(first.tabId);
        expect(closed.remainingTabIds).toEqual([second.tabId]);
        const gone = yield* run(
          request("click", { x: 1, y: 1 }, { tabId: first.tabId!, tabIdExplicit: true }),
        ).pipe(Effect.flip);
        expect(gone.tag).toBe("PreviewAutomationTabNotFoundError");
        const stillThere = (yield* run(request("status"))) as PreviewAutomationStatus;
        expect(stillThere.tabId).toBe(second.tabId);
      }).pipe(Effect.scoped, Effect.provide(realChromeLayer)),
    180_000,
  );
});
