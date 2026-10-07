// Tabs: which tab a request means, who owns it, opening and retiring them.
import {
  ThreadId,
  type PreviewAutomationRequest,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { loginOriginCovering } from "./loginOrigins.ts";
import { classifyPageError, HostOperationError } from "./pageOperations.ts";
import { HELP_ENDED_BY_SWITCH, type TabEntry } from "./browserShared.ts";
import type { BrowserCore } from "./browserCore.ts";
import type { BrowserLaunch } from "./browserLaunch.ts";
import type { PersonalBrowser } from "./PersonalBrowser.ts";

export const makeBrowserTabs = (core: BrowserCore, launch: BrowserLaunch) => {
  const {
    abandonHelp,
    lease,
    notify,
    openPage,
    options,
    originOf,
    ownedPages,
    persistProtections,
    previewManager,
    refreshCredentialProtection,
    runFork,
    runtime,
    safeUrl,
    st,
    viewers,
    watchDialogs,
  } = core;
  const { ensureLaunched, syncHumanViewport, syncScreencast } = launch;

  const attempt = <A>(
    input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
    run: () => Promise<A>,
  ) => Effect.tryPromise({ try: run, catch: (cause) => classifyPageError(cause, input) });

  const latestTabForThread = (threadId: string): TabEntry | undefined => {
    let latest: TabEntry | undefined;
    for (const tab of runtime.tabs.values()) {
      if (tab.threadId === threadId && openPage(tab.page)) latest = tab;
    }
    return latest;
  };

  const clearHelpForAgentSwitch = (threadId: ThreadId) =>
    st.activeHelp !== null && st.activeHelp.request.threadId !== threadId
      ? abandonHelp(HELP_ENDED_BY_SWITCH)
      : Effect.void;

  const tabForRequest = (request: PreviewAutomationRequest): TabEntry | undefined => {
    if (request.tabId !== undefined) {
      const tab = runtime.tabs.get(request.tabId);
      if (tab !== undefined && tab.threadId === request.threadId && openPage(tab.page)) return tab;
      // An explicit tab that is gone stays an error; an inherited one falls back.
      if (request.tabIdExplicit === true) return undefined;
    }
    return latestTabForThread(request.threadId);
  };

  const requireTab = (request: PreviewAutomationRequest) => {
    const tab = tabForRequest(request);
    return tab === undefined
      ? Effect.fail(
          new HostOperationError(
            "PreviewAutomationTabNotFoundError",
            "No open browser tab for this thread. Call preview_open first.",
          ),
        )
      : Effect.succeed(tab);
  };

  const setActive = (tab: TabEntry) =>
    Effect.gen(function* () {
      if (runtime.activeTabId === tab.tabId) return;
      runtime.activeTabId = tab.tabId;
      yield* attempt({}, () => tab.page.bringToFront()).pipe(Effect.ignore);
      yield* syncScreencast;
      yield* syncHumanViewport;
      yield* notify;
    });

  const syncPreviewStatus = (tab: TabEntry) =>
    Effect.gen(function* () {
      tab.title = yield* Effect.promise(() => tab.page.title().catch(() => tab.title));
      const url = tab.page.url();
      if (!/^https?:\/\//i.test(url)) return;
      const history = yield* Effect.promise(() =>
        tab.page.history().catch(() => ({ canGoBack: false, canGoForward: false })),
      );
      yield* previewManager
        .reportStatus({
          threadId: tab.threadId,
          tabId: tab.tabId,
          navStatus: {
            _tag: "Success",
            url: url.slice(0, 2_048),
            title: tab.title.slice(0, 512),
          },
          ...history,
        })
        .pipe(Effect.ignore);
    });

  const onTabPageClosed = (tab: TabEntry) =>
    Effect.gen(function* () {
      if (runtime.tabs.get(tab.tabId)?.page !== tab.page) return;
      runtime.tabs.delete(tab.tabId);
      if (runtime.activeTabId === tab.tabId) runtime.activeTabId = null;
      yield* previewManager.close({ threadId: tab.threadId, tabId: tab.tabId }).pipe(Effect.ignore);
      yield* syncScreencast;
      yield* syncHumanViewport;
      yield* notify;
    });

  const createTab = (threadId: ThreadId, url: string | undefined) =>
    Effect.gen(function* () {
      const context = yield* ensureLaunched;
      const snapshot = yield* previewManager
        .open({ threadId, ...(url === undefined ? {} : { url }) })
        .pipe(
          Effect.mapError(
            (error) => new HostOperationError("PreviewAutomationExecutionError", error.message),
          ),
        );
      // Reuse Chrome's initial blank window page before opening another tab.
      const owned = ownedPages();
      const blank = context
        .pages()
        .find(
          (page) =>
            !owned.has(page) &&
            !page.isClosed() &&
            (page.url() === "about:blank" || page.url().startsWith("chrome://newtab")),
        );
      // Compensate the preview registration when the page never materializes,
      // or every retry would orphan another row in the preview manager.
      const page =
        blank ??
        (yield* attempt({}, () => context.newPage()).pipe(
          Effect.tapError(() =>
            previewManager.close({ threadId, tabId: snapshot.tabId }).pipe(Effect.ignore),
          ),
        ));
      const tab: TabEntry = {
        tabId: snapshot.tabId,
        threadId,
        page,
        title: "",
        timeline: [],
        loginProtected: false,
        credentialFormUrl: null,
        scriptTainted: false,
        dialogPromptText: null,
        loginOriginRevision: 0,
      };
      runtime.tabs.set(tab.tabId, tab);
      page.onClose(() => runFork(onTabPageClosed(tab)));
      page.onOriginChange?.(() => {
        tab.loginOriginRevision++;
      });
      watchDialogs(page);
      page.onDialogChange(() => {
        tab.dialogPromptText = null;
      });
      return tab;
    });

  /** Closes one thread's tabs on `origin`, except the one being kept. */
  /**
   * Closes every tab, of every thread, that can see the cookies a login on
   * `origin` is about to create: any of them can hold a script a bot ran
   * earlier, which would still be running when the session arrives.
   */
  const retireTabsInCookieScope = (input: { readonly origin: string; readonly except: TabEntry }) =>
    Effect.gen(function* () {
      const inScope = (url: string) =>
        url !== "about:blank" && loginOriginCovering(url, [input.origin]) !== null;
      // Collected first: closing a tab reaps it out of the same map.
      const doomed = [...runtime.tabs.values()].filter(
        (tab) => tab !== input.except && openPage(tab.page) && inScope(tab.page.url()),
      );
      for (const tab of doomed) {
        yield* Effect.promise(() => tab.page.close().catch(() => undefined));
        yield* onTabPageClosed(tab);
      }
    });

  const releaseThread: PersonalBrowser["Service"]["releaseThread"] = (threadId) =>
    Effect.gen(function* () {
      const owned = [...runtime.tabs.values()].filter((tab) => tab.threadId === threadId);
      for (const tab of owned) {
        // The page's own close handler reaps the tab too; `onTabPageClosed`
        // is keyed on the entry still being the live one, so running it here
        // as well is idempotent and makes the reap synchronous with us.
        yield* Effect.promise(() => tab.page.close().catch(() => undefined));
        yield* onTabPageClosed(tab);
      }
      // Not a resume: the thread is being deleted, and the delete cancels its task.
      if (st.activeHelp?.request.threadId === threadId) st.activeHelp = null;
      yield* lease.releaseThread(threadId);
      yield* notify;
    });

  /**
   * The tab a saved login was typed into is closed to the model while the
   * credential form is still the document: the value is sitting in it. Once
   * that tab has navigated away from the form the password is gone from the
   * page, so it reads normally again — every bot shares the saved logins and
   * the sessions they create, so no other tab is restricted at all.
   *
   * A query string is the exception. A `method="GET"` login form puts the
   * password in the URL, and a snapshot would report it, so a tab that
   * navigated to a URL carrying one stays closed.
   */
  const statusOf = (tab: TabEntry | undefined): PreviewAutomationStatus => {
    refreshCredentialProtection(tab);
    return {
      available: runtime.phase !== "locked",
      visible: viewers.size > 0 || !options.headless,
      tabId: tab?.tabId ?? null,
      url: tab !== undefined && openPage(tab.page) ? safeUrl(tab, tab.page.url()) : null,
      title: tab?.title ?? null,
      loading: runtime.phase === "starting",
    };
  };

  /**
   * Records that a model-provided script was allowed to run here, before it
   * runs. A script can install an input listener or register a service
   * worker, and neither is undone by disabling later `evaluate` calls, so
   * the origin is remembered for the life of the profile and never receives
   * a saved login again.
   */
  const taintForScript = (tab: TabEntry) =>
    Effect.gen(function* () {
      tab.scriptTainted = true;
      const origin = openPage(tab.page) ? originOf(tab.page.url()) : null;
      if (origin === null || runtime.taintedOrigins.has(origin)) return;
      runtime.taintedOrigins.add(origin);
      yield* persistProtections.pipe(
        Effect.tapError(() => Effect.sync(() => runtime.taintedOrigins.delete(origin))),
        Effect.mapError(
          () =>
            new HostOperationError(
              "PreviewAutomationExecutionError",
              "Page-script access could not be recorded, so the script was not run.",
            ),
        ),
      );
    });

  return {
    attempt,
    clearHelpForAgentSwitch,
    createTab,
    latestTabForThread,
    onTabPageClosed,
    releaseThread,
    requireTab,
    retireTabsInCookieScope,
    setActive,
    statusOf,
    syncPreviewStatus,
    tabForRequest,
    taintForScript,
  };
};

export type BrowserTabs = ReturnType<typeof makeBrowserTabs>;
