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
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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
  locatorCount = 0;

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
  async countLocator() {
    return this.locatorCount;
  }
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

const baseLayer = <RepositoryError, RepositoryContext>(
  driver: BrowserDriver,
  repository: Layer.Layer<
    PersonalBrowserLeaseRepository.PersonalBrowserLeaseRepository,
    RepositoryError,
    RepositoryContext
  >,
) =>
  PersonalBrowser.makeLayer({ driver, headless: true, executablePath: undefined }).pipe(
    Layer.provideMerge(BrowserLease.layer),
    Layer.provideMerge(repository),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(PreviewManager.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-browser-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const makeLayer = (driver: BrowserDriver) =>
  baseLayer(driver, PersonalBrowserLeaseRepository.layer);

/** A repository pre-seeded with one persisted row, recording every save. */
const stubRepository = (
  row: PersonalBrowserLeaseRepository.BrowserLeaseRow,
  saved: PersonalBrowserLeaseRepository.BrowserLeaseRow[] = [],
) =>
  Layer.succeed(
    PersonalBrowserLeaseRepository.PersonalBrowserLeaseRepository,
    PersonalBrowserLeaseRepository.PersonalBrowserLeaseRepository.of({
      load: () => Effect.succeed(Option.some(row)),
      save: (next) =>
        Effect.sync(() => {
          saved.push(next);
        }),
    }),
  );

/**
 * A row the previous process left behind moments before the restart. The
 * heartbeat sits at the test clock's own boot instant on purpose: boot
 * restores only leases heartbeaten within `RESTART_GRACE_MS` of it, so a
 * fixture dated anywhere else would assert restore behaviour against a lease
 * the real boot path skips.
 */
const persistedAgentRow = (
  lastUrl: string | null,
): PersonalBrowserLeaseRepository.BrowserLeaseRow => ({
  profileId: "default",
  ownerType: "agent",
  ownerId: "thread-a",
  generation: 4,
  heartbeatAt: "1970-01-01T00:00:00.000Z",
  expiresAt: "1970-01-01T00:01:30.000Z",
  lastUrl,
});

/** A row with nothing to restore, so boot leaves the browser lazily offline. */
const releasedPersistedRow = (): PersonalBrowserLeaseRepository.BrowserLeaseRow => ({
  profileId: "default",
  ownerType: "agent",
  ownerId: null,
  generation: 4,
  heartbeatAt: null,
  expiresAt: null,
  lastUrl: null,
});

/** The boot restore runs on a background fiber; wait for its effects, bounded. */
const awaitCondition = <R>(check: Effect.Effect<boolean, never, R>) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 1_000; turn++) {
      if (yield* check) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("condition never became true"));
  });

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

  it.effect("keeps credential-bearing tabs unreadable to the model after filling", () => {
    const fake = makeFakeDriver();
    fake.state.page.locatorCount = 1;
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      const filled = yield* browser.fillLogin({
        threadId,
        expectedOrigin: "https://example.com",
        username: "person@example.com",
        password: "password-value",
      });
      expect(filled).toEqual(["username", "password"]);

      for (const blocked of [
        request("snapshot"),
        request("evaluate", { expression: "document.querySelector('input').value" }),
        request("type", { locator: "input", text: "copy it", clear: true }),
        request("click", { locator: "input[value^='p']" }),
        request("scroll", { locator: "input[value^='p']", deltaY: 1 }),
        request("waitFor", { locator: "input[value^='p']" }),
      ]) {
        const error = yield* browser
          .handleAutomationRequest(blocked)
          .pipe(Effect.asVoid, Effect.flip);
        expect(error.message).toMatch(
          /contains a saved login|after a saved login|Page scripts are disabled/,
        );
      }

      // Non-querying submission paths remain possible without exposing page state.
      yield* browser.handleAutomationRequest(request("click", { x: 1, y: 1 }));
      yield* browser.handleAutomationRequest(request("press", { key: "Enter" }));
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect(
    "blocks agent clipboard shortcuts that could move a password into a readable tab",
    () => {
      const fake = makeFakeDriver();
      return Effect.gen(function* () {
        const browser = yield* PersonalBrowser.PersonalBrowser;
        yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
        const error = yield* browser
          .handleAutomationRequest(request("press", { key: "Insert", modifiers: ["Shift"] }))
          .pipe(Effect.asVoid, Effect.flip);
        expect(error.message).toContain("Clipboard shortcuts are disabled");
      }).pipe(Effect.provide(makeLayer(fake.driver)));
    },
  );

  it.effect("keeps the tab protected when a credential fill fails", () => {
    const fake = makeFakeDriver();
    fake.state.page.locatorCount = 1;
    fake.state.page.typeText = async () => {
      throw new Error("late fill failure");
    };
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      yield* browser
        .fillLogin({
          threadId,
          expectedOrigin: "https://example.com",
          username: "person@example.com",
          password: "password-value",
        })
        .pipe(Effect.asVoid, Effect.flip);

      const error = yield* browser
        .handleAutomationRequest(request("snapshot"))
        .pipe(Effect.asVoid, Effect.flip);
      expect(error.message).toContain("contains a saved login");
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

  it.effect("records the agent's page so a later restart can reopen it", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      const lease = yield* BrowserLease.BrowserLease;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      expect((yield* lease.view).lastUrl).toBe("https://example.com/");
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect("deleting the thread closes its tab and gives up the browser", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      const lease = yield* BrowserLease.BrowserLease;
      const open = (yield* browser.handleAutomationRequest(
        request("navigate", { url: "example.com" }),
      )) as PreviewAutomationStatus;
      expect(open.tabId).not.toBeNull();
      expect((yield* lease.view).lastUrl).toBe("https://example.com/");

      yield* browser.releaseThread(threadId);

      // Nothing of the deleted chat survives in the browser: no tab, no
      // controller on the Computer screen, and no page for the next restart
      // to reopen.
      expect(fake.state.page.closed).toBe(true);
      expect(yield* lease.view).toMatchObject({ ownerId: null, lastUrl: null });
      expect((yield* browser.status("session-1")).controller).toEqual({ _tag: "None" });
      expect(
        ((yield* browser.handleAutomationRequest(request("status"))) as PreviewAutomationStatus)
          .tabId,
      ).toBeNull();
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect("closing the browser ends the session and leaves nothing to restore", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      const lease = yield* BrowserLease.BrowserLease;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      expect((yield* lease.view).lastUrl).toBe("https://example.com/");

      const closed = yield* browser.closeBrowser({ sessionId: "session-1", byThreadId: null });

      expect(closed.state).toBe("offline");
      expect(closed.controller).toEqual({ _tag: "None" });
      expect(fake.state.page.closed).toBe(true);
      // No saved page, so a restart after a close cannot resurrect the session.
      expect(yield* lease.view).toMatchObject({ ownerId: null, lastUrl: null });
      expect(
        ((yield* browser.handleAutomationRequest(request("status"))) as PreviewAutomationStatus)
          .tabId,
      ).toBeNull();
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect("records one close, and a second close is a no-op", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      yield* browser.closeBrowser({ sessionId: "session-1", byThreadId: null });
      yield* browser.closeBrowser({ sessionId: "session-1", byThreadId: null });

      const head = yield* browser.activity("session-1").pipe(Stream.take(1), Stream.runCollect);
      const recent = head[0];
      expect(recent?._tag).toBe("Recent");
      const closes =
        recent?._tag === "Recent"
          ? recent.events.filter((event) => event.summary === "Browser closed by you")
          : [];
      expect(closes).toHaveLength(1);

      // Closed twice, and the browser still starts again on the next op.
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      expect(fake.state.launches).toBe(2);
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect("a browser closed before the restart is not reopened at boot", () => {
    const fake = makeFakeDriver();
    const saved: PersonalBrowserLeaseRepository.BrowserLeaseRow[] = [];
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      yield* browser.closeBrowser({ sessionId: "session-1", byThreadId: null });

      // The row a later boot would read has no owner and no page left, so the
      // restore decision it drives is a no-op rather than a reopen.
      const persisted = saved.at(-1)!;
      expect(persisted).toMatchObject({ ownerType: "agent", ownerId: null, lastUrl: null });
      expect(BrowserLease.decideBrowserRestore(persisted, 0)).toEqual({ _tag: "Noop" });
    }).pipe(Effect.provide(baseLayer(fake.driver, stubRepository(releasedPersistedRow(), saved))));
  });

  it.effect("reopens the agent's last page at boot and re-attaches the lease", () => {
    const fake = makeFakeDriver();
    const saved: PersonalBrowserLeaseRepository.BrowserLeaseRow[] = [];
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      // The restore runs on a background fiber at boot; wait for its effects.
      yield* awaitCondition(Effect.sync(() => fake.state.page.gotos.length > 0));
      expect(fake.state.launches).toBe(1);
      expect(fake.state.page.gotos).toEqual(["https://example.com/"]);
      const status = yield* browser.status("session-1");
      expect(status.controller).toEqual({
        _tag: "Agent",
        threadId,
        botId: null,
        botName: null,
      });
      expect(status.page?.url).toBe("https://example.com/");
      // Boot normalization persisted the extended lease.
      expect(saved.length).toBeGreaterThan(0);
    }).pipe(
      Effect.provide(
        baseLayer(fake.driver, stubRepository(persistedAgentRow("example.com"), saved)),
      ),
    );
  });

  it.effect("a failed boot restore degrades to a clean None instead of crashing boot", () => {
    const saved: PersonalBrowserLeaseRepository.BrowserLeaseRow[] = [];
    const broken: BrowserDriver = {
      launch: async () => {
        throw new Error("no chrome");
      },
    };
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      const lease = yield* BrowserLease.BrowserLease;
      yield* awaitCondition(Effect.map(lease.view, (view) => view.ownerId === null));
      // Boot completed and the lease is clean; the launch failure is still
      // reported through the usual browser state.
      const status = yield* browser.status("session-1");
      expect(status.controller).toEqual({ _tag: "None" });
      expect(saved.at(-1)).toMatchObject({ ownerType: "agent", ownerId: null });
    }).pipe(
      Effect.provide(
        baseLayer(broken, stubRepository(persistedAgentRow("https://example.com/"), saved)),
      ),
    );
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
