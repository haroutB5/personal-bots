import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PersonalBrowserInputMessage,
  ThreadId,
  type PreviewAutomationRequest,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as BrowserLease from "./BrowserLease.ts";
import type { BrowserDriver, BrowserPage, ScreencastMeta } from "./driver.ts";
import * as PersonalBrowser from "./PersonalBrowser.ts";
import * as PersonalBrowserLeaseRepository from "./PersonalBrowserLeaseRepository.ts";

const encodeInput = Schema.encodeSync(Schema.fromJsonString(PersonalBrowserInputMessage));

/** A page that records what it was asked to do; `goto` can be held open. */
class FakePage implements BrowserPage {
  currentUrl = "about:blank";
  closed = false;
  readonly gotos: string[] = [];
  screencasts = 0;
  stoppedScreencasts = 0;
  gotoGate: Promise<void> | null = null;
  onGoto: ((url: string) => void) | null = null;

  url() {
    return this.currentUrl;
  }
  async title() {
    return this.currentUrl === "about:blank" ? "" : "Fake page";
  }
  isClosed() {
    return this.closed;
  }
  async goto(url: string) {
    this.gotos.push(url);
    this.onGoto?.(url);
    if (this.gotoGate !== null) await this.gotoGate;
    this.currentUrl = url;
  }
  async goBack() {}
  async goForward() {}
  async reload() {}
  async history() {
    return { canGoBack: false, canGoForward: false };
  }
  async clickLocator() {}
  async typeText() {}
  async scrollLocator() {}
  async waitForLocator() {}
  async waitForText() {}
  async waitForUrlIncludes() {}
  evaluateImpl: ((expression: string) => Promise<unknown>) | null = null;
  async evaluate(expression: string) {
    if (this.evaluateImpl !== null) return this.evaluateImpl(expression);
    return null;
  }
  async screenshotPng() {
    return new Uint8Array([137, 80, 78, 71]);
  }
  async accessibilityTree() {
    return { nodes: [] };
  }
  async setViewport() {}
  async viewportSize() {
    return { width: 390, height: 844 };
  }
  async setColorScheme() {}
  async bringToFront() {}
  async mouseMove() {}
  async mouseDown() {}
  async mouseUp() {}
  async mouseClick() {}
  async mouseWheel() {}
  async keyPress() {}
  async insertText() {}
  consoleEntries() {
    return [];
  }
  networkEntries() {
    return [];
  }
  async startScreencast(_onFrame: (jpeg: Uint8Array, meta: ScreencastMeta) => void) {
    this.screencasts++;
    return async () => {
      this.stoppedScreencasts++;
    };
  }
  onClose() {}
  async close() {
    this.closed = true;
  }
}

const makeFakeDriver = () => {
  const page = new FakePage();
  const state = { launches: 0, page };
  const driver: BrowserDriver = {
    launch: async () => {
      state.launches++;
      const pages: FakePage[] = [page];
      return {
        pages: () => pages.filter((candidate) => !candidate.closed),
        newPage: async () => {
          const created = new FakePage();
          pages.push(created);
          return created;
        },
        onClose: () => {},
        close: async () => {},
      };
    },
  };
  return { driver, state };
};

const makeLayer = (driver: BrowserDriver) =>
  PersonalBrowser.makeLayer({ driver, headless: true, executablePath: undefined }).pipe(
    Layer.provideMerge(BrowserLease.layer),
    Layer.provideMerge(PersonalBrowserLeaseRepository.layer),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(PreviewManager.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-browser-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const threadId = ThreadId.make("thread-a");
let requestSequence = 0;
const request = (
  operation: PreviewAutomationRequest["operation"],
  input: unknown = {},
  timeoutMs = 15_000,
): PreviewAutomationRequest => ({
  requestId: `request-${requestSequence++}`,
  threadId,
  operation,
  input,
  timeoutMs,
});

describe("PersonalBrowser", () => {
  it.effect("answers status immediately: no launch, and no waiting behind an in-flight op", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      const idle = (yield* browser.handleAutomationRequest(
        request("status"),
      )) as PreviewAutomationStatus;
      expect(idle).toMatchObject({ available: true, tabId: null, url: null });
      expect(fake.state.launches).toBe(0);

      let releaseGoto!: () => void;
      fake.state.page.gotoGate = new Promise((resolve) => {
        releaseGoto = resolve;
      });
      const gotoStarted = new Promise<void>((resolve) => {
        fake.state.page.onGoto = () => resolve();
      });
      const navigate = yield* browser
        .handleAutomationRequest(request("navigate", { url: "example.com" }))
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => gotoStarted);

      const during = (yield* browser.handleAutomationRequest(
        request("status"),
      )) as PreviewAutomationStatus;
      expect(during.tabId).not.toBeNull();
      expect(during.url).toBe("about:blank");

      releaseGoto();
      const done = (yield* Fiber.join(navigate)) as PreviewAutomationStatus;
      expect(done).toMatchObject({ tabId: during.tabId, url: "https://example.com/" });
      expect(fake.state.launches).toBe(1);
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect("a wedged evaluate times out and releases the browser for the next op", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      // `new Promise(() => {})`: settles never, so without a bound this op
      // would hold the shared-browser lock until a server restart.
      fake.state.page.evaluateImpl = () => new Promise<unknown>(() => {});
      const error = yield* browser
        .handleAutomationRequest(request("evaluate", { expression: "new Promise(() => {})" }, 50))
        .pipe(Effect.asVoid, Effect.flip);
      expect(error.tag).toBe("PreviewAutomationTimeoutError");

      // The lock was released: the next op settles instead of timing out.
      fake.state.page.evaluateImpl = (expression) => Promise.resolve(`ran:${expression}`);
      const next = yield* browser.handleAutomationRequest(
        request("evaluate", { expression: "document.title" }, 5_000),
      );
      expect(next).toBe("ran:document.title");
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect("rejects agent navigation to non-http schemes without touching the page", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      for (const url of ["javascript:alert(1)", "file:///C:/Windows/win.ini"]) {
        const error = yield* browser
          .handleAutomationRequest(request("navigate", { url }))
          .pipe(Effect.asVoid, Effect.flip);
        expect(error.tag).toBe("PreviewAutomationExecutionError");
      }
      expect(fake.state.page.gotos).toEqual([]);
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect("accepts viewer input only from the session holding human control", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const viewer = yield* browser.attachViewer({ sessionId: "session-1", canOperate: true });
          const navigate = (url: string) =>
            browser.handleViewerMessage(viewer, encodeInput({ _tag: "Navigate", url }));

          yield* navigate("https://t3.chat");
          expect(yield* Queue.take(viewer.outbox)).toContain("Take control");

          const status = yield* browser.takeControl("session-1");
          expect(status.controller).toEqual({ _tag: "Human", self: true, connected: true });
          expect((yield* browser.status("session-2")).controller).toEqual({
            _tag: "Human",
            self: false,
            connected: true,
          });

          yield* navigate("javascript:alert(1)");
          expect(yield* Queue.take(viewer.outbox)).toContain("InputRejected");
          yield* navigate("t3.chat");
          expect(fake.state.page.gotos.at(-1)).toBe("https://t3.chat/");

          const other = yield* browser.attachViewer({ sessionId: "session-2", canOperate: true });
          yield* browser.handleViewerMessage(other, encodeInput({ _tag: "Reload" }));
          expect(yield* Queue.take(other.outbox)).toContain("Take control");

          const readOnly = yield* browser.attachViewer({
            sessionId: "session-1",
            canOperate: false,
          });
          yield* browser.handleViewerMessage(readOnly, encodeInput({ _tag: "Reload" }));
          expect(yield* Queue.take(readOnly.outbox)).toContain("read-only");

          // While the human drives, agent ops are refused with a clear reason.
          const blocked = yield* browser
            .handleAutomationRequest(request("snapshot"))
            .pipe(Effect.asVoid, Effect.flip);
          expect(blocked.tag).toBe("PreviewAutomationControlInterruptedError");
        }),
      );
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect("screencasts only while at least one viewer is attached", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      expect(fake.state.page.screencasts).toBe(0);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* browser.attachViewer({ sessionId: "session-1", canOperate: false });
          yield* browser.attachViewer({ sessionId: "session-2", canOperate: false });
          expect(fake.state.page.screencasts).toBe(1);
          expect((yield* browser.status("session-1")).viewers).toBe(2);
        }),
      );
      expect(fake.state.page.stoppedScreencasts).toBe(1);
      expect((yield* browser.status("session-1")).viewers).toBe(0);
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });
});
