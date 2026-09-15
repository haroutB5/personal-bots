import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PersonalBotId,
  PersonalBrowserInputMessage,
  PersonalTaskId,
  ThreadId,
  type PersonalTask,
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
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as BrowserLease from "./BrowserLease.ts";
import type { BrowserDriver, BrowserElementHandle, BrowserPage, ScreencastMeta } from "./driver.ts";
import * as PersonalBrowser from "./PersonalBrowser.ts";
import * as PersonalBrowserLeaseRepository from "./PersonalBrowserLeaseRepository.ts";
import * as PersonalBrowserProtectionRepository from "./PersonalBrowserProtectionRepository.ts";

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
  countLocatorImpl: ((locator: string) => number) | null = null;
  async countLocator(locator: string) {
    return this.countLocatorImpl?.(locator) ?? this.locatorCount;
  }
  readonly filled: Array<{ readonly locator: string; readonly text: string }> = [];
  resolveElementImpl: ((locator: string) => BrowserElementHandle | null) | null = null;
  async resolveElement(locator: string): Promise<BrowserElementHandle | null> {
    if (this.resolveElementImpl !== null) return this.resolveElementImpl(locator);
    if (this.locatorCount === 0) return null;
    return {
      fill: async (text: string) => {
        this.filled.push({ locator, text });
      },
      dispose: async () => {},
    };
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

/**
 * Makes one fake page look like an ordinary login page: one match for every
 * login selector, and no form whose `action` posts to another origin.
 */
const configureLoginPage = (page: FakePage) => {
  page.locatorCount = 1;
  page.countLocatorImpl = () => 1;
  // The fill resolves the form's real submission target in the page; an
  // ordinary login form posts back to the page it is on. Anything else the
  // server evaluates here is a snapshot.
  page.evaluateImpl = async (expression: string) =>
    expression.includes('input[type="password"]')
      ? {
          found: true,
          hasForm: true,
          baseUri: page.currentUrl,
          action: page.currentUrl,
          submitters: [],
        }
      : {
          url: page.currentUrl,
          title: "Fake page",
          loading: false,
          visibleText: "",
          interactiveElements: [],
        };
};

const makeFakeDriver = () => {
  const page = new FakePage();
  const pages: FakePage[] = [page];
  const state = { launches: 0, page, pages, onNewPage: null as ((page: FakePage) => void) | null };
  const driver: BrowserDriver = {
    launch: async () => {
      state.launches++;
      return {
        pages: () => pages.filter((candidate) => !candidate.closed),
        newPage: async () => {
          const created = new FakePage();
          state.onNewPage?.(created);
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

/**
 * Every page this browser opens is an ordinary login page. A saved login is
 * filled into a tab the server opens for itself, so configuring only the tab
 * the bot navigated would leave the page that actually receives the fill bare.
 */
const asLoginBrowser = (fake: ReturnType<typeof makeFakeDriver>) => {
  configureLoginPage(fake.state.page);
  fake.state.onNewPage = configureLoginPage;
};

/**
 * A protection store that outlives the service, the way the SQLite row does.
 * Building the layer twice over one of these is a server restart against the
 * same still-authenticated browser profile.
 */
const memoryProtectionRepository = () => {
  const saved: PersonalBrowserProtectionRepository.BrowserProtectionState[] = [];
  const layer = Layer.succeed(
    PersonalBrowserProtectionRepository.PersonalBrowserProtectionRepository,
    PersonalBrowserProtectionRepository.PersonalBrowserProtectionRepository.of({
      load: () => Effect.succeed(Option.fromNullishOr(saved.at(-1))),
      save: (state) =>
        Effect.sync(() => {
          saved.push(state);
        }),
    }),
  );
  return { saved, layer };
};

interface TaskHarness {
  readonly waits: PersonalTaskId[];
  readonly resumes: Array<{
    readonly taskId: PersonalTaskId;
    readonly note: string;
  }>;
}

const taskServiceLayer = (harness: TaskHarness) =>
  Layer.mock(PersonalTaskService.PersonalTaskService)({
    waitForBrowser: ({ taskId }) =>
      Effect.sync(() => {
        harness.waits.push(taskId);
        return {} as PersonalTask;
      }),
    resumeFromUser: ({ taskId, note }) =>
      Effect.sync(() => {
        harness.resumes.push({ taskId, note });
        return {} as PersonalTask;
      }),
  });

const baseLayer = <RepositoryError, RepositoryContext, ProtectionContext>(
  driver: BrowserDriver,
  repository: Layer.Layer<
    PersonalBrowserLeaseRepository.PersonalBrowserLeaseRepository,
    RepositoryError,
    RepositoryContext
  >,
  protections: Layer.Layer<
    PersonalBrowserProtectionRepository.PersonalBrowserProtectionRepository,
    never,
    ProtectionContext
  >,
  taskHarness: TaskHarness = { waits: [], resumes: [] },
) =>
  PersonalBrowser.makeLayer({ driver, headless: true, executablePath: undefined }).pipe(
    Layer.provideMerge(BrowserLease.layer),
    Layer.provideMerge(repository),
    Layer.provideMerge(protections),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(taskServiceLayer(taskHarness)),
    Layer.provideMerge(PreviewManager.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-browser-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const makeLayer = (driver: BrowserDriver, taskHarness?: TaskHarness) =>
  baseLayer(
    driver,
    PersonalBrowserLeaseRepository.layer,
    PersonalBrowserProtectionRepository.layer,
    taskHarness,
  );

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
    asLoginBrowser(fake);
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      const filled = yield* browser.fillLogin({
        threadId,
        label: "Example",
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

  // Saved logins are shared by every bot by design, so the signed-in site is
  // not gated per bot. What is gated is the document the password is sitting
  // in, for whoever asks.
  it.effect("leaves other threads free on the signed-in origin while the form is open", () => {
    const fake = makeFakeDriver();
    asLoginBrowser(fake);
    const otherThread = ThreadId.make("thread-other");
    const otherRequest = (operation: PreviewAutomationRequest["operation"], input: unknown = {}) =>
      ({ ...request(operation, input), threadId: otherThread }) as PreviewAutomationRequest;
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(
        request("navigate", { url: "https://example.com/sign-in" }),
      );
      yield* browser.fillLogin({
        threadId,
        label: "Example",
        expectedOrigin: "https://example.com",
        username: "person@example.com",
        password: "password-value",
      });

      // Another thread opens the same site and reads it: it inherits the
      // session, which is the point of sharing the saved login.
      yield* browser.handleAutomationRequest(
        otherRequest("navigate", { url: "https://example.com/account" }),
      );
      yield* browser.handleAutomationRequest(otherRequest("snapshot"));

      // Page scripts stay disabled for everyone while the profile holds the
      // session the credential created.
      const scripted = yield* browser
        .handleAutomationRequest(otherRequest("evaluate", { expression: "document.cookie" }))
        .pipe(Effect.asVoid, Effect.flip);
      expect(scripted.message).toContain("Page scripts are disabled");

      // The tab the password went into is still closed, to its own thread too.
      const onForm = yield* browser
        .handleAutomationRequest(request("snapshot"))
        .pipe(Effect.asVoid, Effect.flip);
      expect(onForm.message).toContain("contains a saved login");
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect(
    "keeps scripts blocked on credential origins after closing and reopening Chrome",
    () => {
      const fake = makeFakeDriver();
      asLoginBrowser(fake);
      return Effect.gen(function* () {
        const browser = yield* PersonalBrowser.PersonalBrowser;
        yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
        yield* browser.fillLogin({
          threadId,
          label: "Example",
          expectedOrigin: "https://example.com",
          username: "person",
          password: "password-value",
        });
        yield* browser.closeBrowser({ sessionId: "session-1", byThreadId: null });
        yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
        const result = yield* browser
          .handleAutomationRequest(request("evaluate", { expression: "document.cookie" }))
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(makeLayer(fake.driver)));
    },
  );

  // A login form with method="GET" puts the password in the query string.
  it.effect("strips the query string from a protected tab's reported url", () => {
    const fake = makeFakeDriver();
    asLoginBrowser(fake);
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      yield* browser.fillLogin({
        threadId,
        label: "Example",
        expectedOrigin: "https://example.com",
        username: "person@example.com",
        password: "password-value",
      });
      yield* browser.handleAutomationRequest(
        request("navigate", { url: "https://example.com/in?user=person&pw=password-value#t" }),
      );

      const status = (yield* browser.handleAutomationRequest(
        request("status"),
      )) as PreviewAutomationStatus;
      expect(status.url).toBe("https://example.com/in");
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
    asLoginBrowser(fake);
    // The fill lands on the tab the server opens, so the failure is injected
    // into every page this browser creates, not just the one the bot opened.
    fake.state.onNewPage = (page) => {
      configureLoginPage(page);
      page.typeText = async () => {
        throw new Error("late fill failure");
      };
    };
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      yield* browser
        .fillLogin({
          threadId,
          label: "Example",
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

  it.effect("records browser help and resumes its task when the user returns control", () => {
    const fake = makeFakeDriver();
    const taskHarness: TaskHarness = { waits: [], resumes: [] };
    const taskId = PersonalTaskId.make("task-browser-help");
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));

      const help = yield* browser.requestHelp({
        threadId,
        botId: PersonalBotId.make("bot-assistant"),
        botName: "Assistant",
        taskId,
        reason: "CAPTCHA on example.com",
      });
      expect(help).toMatchObject({
        threadId,
        botName: "Assistant",
        reason: "CAPTCHA on example.com",
      });
      expect((yield* browser.status("session-1")).helpRequest).toEqual(help);
      expect(taskHarness.waits).toEqual([taskId]);

      const taken = yield* browser.takeControl("session-1");
      expect(taken.helpRequest).toEqual(help);
      const returned = yield* browser.returnToAgent("session-1");
      expect(returned.helpRequest).toBeNull();
      expect(taskHarness.resumes).toEqual([
        {
          taskId,
          note: "The user finished helping in the browser. Continue the task.",
        },
      ]);

      const head = yield* browser.activity("session-1").pipe(Stream.take(1), Stream.runCollect);
      const summaries =
        head[0]?._tag === "Recent" ? head[0].events.map((event) => event.summary) : [];
      expect(summaries).toContain("Assistant asked for help: CAPTCHA on example.com");
      expect(summaries).toContain("You finished helping");
    }).pipe(Effect.provide(makeLayer(fake.driver, taskHarness)));
  });

  it.effect("clears browser help when the browser closes", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      yield* browser.requestHelp({
        threadId,
        botId: PersonalBotId.make("bot-assistant"),
        botName: "Assistant",
        taskId: PersonalTaskId.make("task-browser-close"),
        reason: "Login required",
      });

      const closed = yield* browser.closeBrowser({ sessionId: "session-1", byThreadId: null });
      expect(closed.helpRequest).toBeNull();
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect("rejects browser help from a thread that does not hold the lease", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));

      const error = yield* browser
        .requestHelp({
          threadId: ThreadId.make("thread-b"),
          botId: PersonalBotId.make("bot-other"),
          botName: "Other",
          taskId: PersonalTaskId.make("task-other"),
          reason: "2FA required",
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("currently controlling");
      expect((yield* browser.status("session-1")).helpRequest).toBeNull();
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  it.effect("clears browser help when another thread takes the expired lease", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      yield* browser.requestHelp({
        threadId,
        botId: PersonalBotId.make("bot-assistant"),
        botName: "Assistant",
        taskId: PersonalTaskId.make("task-agent-switch"),
        reason: "CAPTCHA",
      });

      yield* TestClock.adjust("91 seconds");
      yield* browser.handleAutomationRequest({
        ...request("navigate", { url: "t3.chat" }),
        threadId: ThreadId.make("thread-b"),
      });

      expect((yield* browser.status("session-1")).helpRequest).toBeNull();
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

  // Audit #6: the authority check used to sit in the MCP handler, so a
  // takeover could land between "no human is in control" and Chrome exiting.
  it.effect("refuses a bot's close from inside the lease, after a human takes over", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      yield* browser.takeControl("session-1");

      const refused = yield* browser
        .closeBrowser({ sessionId: "mcp", byThreadId: threadId })
        .pipe(Effect.asVoid, Effect.flip);

      expect(refused.tag).toBe("PreviewAutomationControlInterruptedError");
      // Chrome is still up and the page the user is reading is still open.
      expect(fake.state.page.closed).toBe(false);
      expect((yield* browser.status("session-1")).state).toBe("connected");

      // The user's own close is not subject to that check.
      const closed = yield* browser.closeBrowser({ sessionId: "session-1", byThreadId: null });
      expect(closed.state).toBe("offline");
      expect(fake.state.page.closed).toBe(true);
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  // The other half of #6: the close is serialized with agent operations, so it
  // cannot tear the context down underneath one that is already past launch.
  it.effect("agent close with an idle lease", () => {
    const fake = makeFakeDriver();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      const closed = yield* browser.closeBrowser({ sessionId: "mcp", byThreadId: threadId });
      expect(closed.state).toBe("offline");
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
    }).pipe(
      Effect.provide(
        baseLayer(
          fake.driver,
          stubRepository(releasedPersistedRow(), saved),
          PersonalBrowserProtectionRepository.layer,
        ),
      ),
    );
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
        baseLayer(
          fake.driver,
          stubRepository(persistedAgentRow("example.com"), saved),
          PersonalBrowserProtectionRepository.layer,
        ),
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
        baseLayer(
          broken,
          stubRepository(persistedAgentRow("https://example.com/"), saved),
          PersonalBrowserProtectionRepository.layer,
        ),
      ),
    );
  });

  // Audit #2: preview_evaluate can install an input listener or register a
  // service worker before the fill, and disabling later evaluate calls does
  // not remove either.
  it.effect("refuses a saved login on an origin where a page script has run", () => {
    const fake = makeFakeDriver();
    asLoginBrowser(fake);
    const protections = memoryProtectionRepository();
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
      yield* browser.handleAutomationRequest(
        request("evaluate", { expression: "addEventListener('input', steal)" }),
      );

      const error = yield* browser
        .fillLogin({
          threadId,
          label: "Example",
          expectedOrigin: "https://example.com",
          username: "person@example.com",
          password: "password-value",
        })
        .pipe(Effect.asVoid, Effect.flip);

      expect(error.message).toContain("A page script was run on https://example.com");
      expect(fake.state.pages.flatMap((page) => page.filled)).toEqual([]);
      // The taint is recorded where a restart can still see it.
      expect(protections.saved.at(-1)?.taintedOrigins).toEqual(["https://example.com"]);
    }).pipe(
      Effect.provide(
        baseLayer(fake.driver, PersonalBrowserLeaseRepository.layer, protections.layer),
      ),
    );
  });

  // Audit #2: the tab the bot has been driving is never the fill target, so a
  // script it installed before the grant was used cannot watch the fill.
  it.effect("fills into a tab the server opened and retires the bot's own tab", () => {
    const fake = makeFakeDriver();
    asLoginBrowser(fake);
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(
        request("navigate", { url: "https://example.com/sign-in" }),
      );
      const filled = yield* browser.fillLogin({
        threadId,
        label: "Example",
        expectedOrigin: "https://example.com",
        username: "person@example.com",
        password: "password-value",
      });
      expect(filled).toEqual(["username", "password"]);

      const [botPage, fillPage] = fake.state.pages;
      expect(fake.state.pages).toHaveLength(2);
      // The bot's page never saw the password and is gone.
      expect(botPage?.filled).toEqual([]);
      expect(botPage?.closed).toBe(true);
      // The fill tab is a fresh document the server navigated itself.
      expect(fillPage?.gotos).toEqual(["https://example.com/sign-in"]);
      expect(fillPage?.filled).toHaveLength(1);

      // And the thread's next tool call routes to the fill tab, not the
      // retired one, so the bot can still submit the form.
      const status = (yield* browser.handleAutomationRequest(
        request("status"),
      )) as PreviewAutomationStatus;
      expect(status.url).toBe("https://example.com/sign-in");
    }).pipe(Effect.provide(makeLayer(fake.driver)));
  });

  // Audit #3: Chrome's profile keeps the signed-in cookies across a restart,
  // so the protections in front of them have to come back too.
  it.effect("restores credential protections after a server restart", () => {
    const protections = memoryProtectionRepository();
    const first = makeFakeDriver();
    asLoginBrowser(first);
    const second = makeFakeDriver();
    asLoginBrowser(second);
    const layerFor = (fake: ReturnType<typeof makeFakeDriver>) =>
      baseLayer(fake.driver, PersonalBrowserLeaseRepository.layer, protections.layer);

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const browser = yield* PersonalBrowser.PersonalBrowser;
        // One origin gets a model-provided script, another gets the login.
        yield* browser.handleAutomationRequest(request("navigate", { url: "other.example" }));
        yield* browser.handleAutomationRequest(request("evaluate", { expression: "1" }));
        yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
        yield* browser.fillLogin({
          threadId,
          label: "Example",
          expectedOrigin: "https://example.com",
          username: "person@example.com",
          password: "password-value",
        });
      }).pipe(Effect.provide(layerFor(first)));

      expect(protections.saved.at(-1)).toMatchObject({
        loginUsed: true,
        taintedOrigins: ["https://other.example"],
      });

      // A new process over the same still-signed-in profile: page scripts stay
      // disabled, and the tainted origin still refuses a fill.
      yield* Effect.gen(function* () {
        const browser = yield* PersonalBrowser.PersonalBrowser;
        yield* browser.handleAutomationRequest(request("navigate", { url: "example.com" }));
        const scripted = yield* browser
          .handleAutomationRequest(request("evaluate", { expression: "document.cookie" }))
          .pipe(Effect.asVoid, Effect.flip);
        expect(scripted.message).toContain("Page scripts are disabled");

        yield* browser.handleAutomationRequest(request("navigate", { url: "other.example" }));
        const refused = yield* browser
          .fillLogin({
            threadId,
            label: "Other",
            expectedOrigin: "https://other.example",
            username: "person@example.com",
            password: "password-value",
          })
          .pipe(Effect.asVoid, Effect.flip);
        expect(refused.message).toContain("A page script was run on https://other.example");
      }).pipe(Effect.provide(layerFor(second)));
    });
  });

  // Audit #5: the post-login workflow was blocked for everyone, including the
  // bot that had just signed the user in. Saved logins are shared, so the only
  // thing that stays closed is the document the password is in, and only until
  // that tab leaves the form.
  it.effect("reopens the credential tab to reads once it has left the form", () => {
    const fake = makeFakeDriver();
    asLoginBrowser(fake);
    return Effect.gen(function* () {
      const browser = yield* PersonalBrowser.PersonalBrowser;
      yield* browser.handleAutomationRequest(
        request("navigate", { url: "https://example.com/sign-in" }),
      );
      yield* browser.fillLogin({
        threadId,
        label: "Example",
        expectedOrigin: "https://example.com",
        username: "person@example.com",
        password: "password-value",
      });

      const onForm = yield* browser
        .handleAutomationRequest(request("snapshot"))
        .pipe(Effect.asVoid, Effect.flip);
      expect(onForm.message).toContain("contains a saved login");

      // A GET login form submits to a URL carrying the password, so leaving the
      // form is not enough on its own: a query string keeps the tab closed.
      yield* browser.handleAutomationRequest(
        request("navigate", { url: "https://example.com/in?pw=password-value" }),
      );
      const withQuery = yield* browser
        .handleAutomationRequest(request("snapshot"))
        .pipe(Effect.asVoid, Effect.flip);
      expect(withQuery.message).toContain("contains a saved login");

      // The signed-in page: the password is in neither the document nor the
      // URL, so the tab reads normally again.
      yield* browser.handleAutomationRequest(
        request("navigate", { url: "https://example.com/account" }),
      );
      yield* browser.handleAutomationRequest(request("snapshot"));
      yield* browser.handleAutomationRequest(request("type", { locator: "input", text: "hello" }));

      // Page scripts stay off on that profile all the same.
      const scripted = yield* browser
        .handleAutomationRequest(request("evaluate", { expression: "document.cookie" }))
        .pipe(Effect.asVoid, Effect.flip);
      expect(scripted.message).toContain("Page scripts are disabled");
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
