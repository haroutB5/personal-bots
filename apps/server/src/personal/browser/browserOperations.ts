// @effect-diagnostics nodeBuiltinImport:off - same node access as PersonalBrowser.ts (profile lock, artifacts).
// What a bot can do in the browser: navigate, click, type, read and the rest, with their guards.
import * as NodeCrypto from "node:crypto";
import {
  type PersonalBrowserActivityKind,
  type PreviewAutomationClickInput,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHistoryInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResizeInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationTypeInput,
  type PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { AGENT_LEASE_TTL_MS } from "./BrowserLease.ts";
import {
  LOGIN_SCRIPT_REFUSED,
  guardedExpression,
  loginCookieScopes,
  loginOriginCovering,
} from "./loginOrigins.ts";
import { type BrowserPage, type PageDialog } from "./driver.ts";
import {
  captureSnapshot,
  classifyPageError,
  HostOperationError,
  isReplacedNavigation,
  performClick,
  performDrag,
  performEvaluate,
  performHistory,
  performHover,
  performPress,
  performScroll,
  performType,
  performWaitFor,
} from "./pageOperations.ts";
import { resolveBrowserNavigationTarget, resolveBrowserUrl } from "./urlPolicy.ts";
import {
  HOST_REPLY_MARGIN_MS,
  TIMELINE_LIMIT,
  type TabEntry,
  UNSTICK_PROBE_MS,
  dialogOpenError,
  driverTimeoutFor,
  firstLine,
  hostOf,
  withoutTypedSecrets,
} from "./browserShared.ts";
import type { BrowserCore } from "./browserCore.ts";
import type { BrowserLaunch } from "./browserLaunch.ts";
import type { BrowserTabs } from "./browserTabs.ts";
import type { PersonalBrowser } from "./PersonalBrowser.ts";

export const makeBrowserOperations = (
  core: BrowserCore,
  launch: BrowserLaunch,
  tabs: BrowserTabs,
) => {
  const {
    REPLACED_NAVIGATION_LOAD_CAP_MS,
    agentViewports,
    botForThread,
    exposeIfSensitive,
    guardEgress,
    lease,
    logBotCheckLanding,
    notify,
    nowIso,
    openPage,
    originOf,
    previewManager,
    recordActivity,
    redactError,
    redactor,
    refreshCredentialProtection,
    refreshSensitiveOrigins,
    runFork,
    runtime,
    safeUrl,
    webOrigin,
  } = core;
  const { ensureLaunched } = launch;
  const {
    attempt,
    clearHelpForAgentSwitch,
    createTab,
    onTabPageClosed,
    requireTab,
    setActive,
    statusOf,
    syncPreviewStatus,
    tabForRequest,
    taintForScript,
  } = tabs;

  /**
   * Runs a navigation. One that Chrome replaced with another that did land somewhere new (a
   * site's redirect to a /sorry or challenge page) is not a failure: the tab is on a page and
   * the caller sees where. Anything else, including a replacement that left the tab on an
   * error page or where it was, is still an error.
   */
  const gotoReplacing = async (
    page: BrowserPage,
    url: string,
    options: Parameters<BrowserPage["goto"]>[1],
  ) => {
    const before = page.url();
    try {
      await page.goto(url, options);
    } catch (cause) {
      if (
        isReplacedNavigation(cause) &&
        openPage(page) &&
        webOrigin(page.url()) !== null &&
        page.url() !== before
      ) {
        // The replacement has committed, not necessarily finished: give it the readiness the
        // caller asked for, for a short while, so the bot's next step sees a page and not a
        // half-loaded one. A page that is slow past the cap is still a page.
        if (options.waitUntil !== "commit") {
          await page
            .waitForLoadState?.(
              options.waitUntil,
              Math.min(REPLACED_NAVIGATION_LOAD_CAP_MS, options.timeoutMs),
            )
            .catch(() => undefined);
        }
        return;
      }
      throw cause;
    }
  };

  const navigateTab = (tab: TabEntry, url: string, readiness: string, timeoutMs: number) =>
    attempt({}, () =>
      gotoReplacing(tab.page, url, {
        waitUntil:
          readiness === "none"
            ? "commit"
            : readiness === "domContentLoaded"
              ? "domcontentloaded"
              : "load",
        timeoutMs,
      }),
    ).pipe(
      // A server-initiated navigation replaces the document, so the listeners
      // a model-provided script installed in the old one go with it. What
      // survives a navigation — a service worker — is held as an origin
      // taint instead, which nothing clears.
      Effect.tap(() =>
        Effect.sync(() => {
          tab.scriptTainted = false;
        }),
      ),
    );

  const rejectUrl = (reason: string) =>
    Effect.fail(new HostOperationError("PreviewAutomationExecutionError", reason));

  const LOGIN_SCRIPTS_DISABLED_EVERYWHERE =
    "Page scripts are disabled after a saved login is used, so browser or page state cannot reveal it.";

  /** Why a model-provided script may not run on `url`, or null when it may. */
  const loginScriptRefusal = (url: string): string | null => {
    if (runtime.loginOriginsUnknown) return LOGIN_SCRIPTS_DISABLED_EVERYWHERE;
    const covering = loginOriginCovering(url, runtime.loginOrigins);
    if (covering === null) return null;
    if (covering === "unknown") {
      return "Page scripts are disabled on this page because a saved login was used in this browser and the page's site cannot be checked. Open an http(s) page first.";
    }
    const pageOrigin = originOf(url) ?? "this page";
    return pageOrigin === covering.origin
      ? `Page scripts are disabled on ${pageOrigin} because a saved login was used there.`
      : `Page scripts are disabled on ${pageOrigin} because a saved login was used on ${covering.origin}, which shares its cookies.`;
  };

  /**
   * A tab with a native dialog open cannot be read or driven: every page
   * call waits on the dialog. Enter and Escape answer it, typing fills a
   * prompt, and anything else says what is open instead of hanging.
   */
  const operateOnDialog = (
    request: PreviewAutomationRequest,
    tab: TabEntry,
    dialog: PageDialog,
  ): Effect.Effect<{ readonly tab: TabEntry; readonly result: unknown }, HostOperationError> =>
    Effect.gen(function* () {
      if (request.operation === "press") {
        const input = request.input as PreviewAutomationPressInput;
        const plain = (input.modifiers?.length ?? 0) === 0;
        if (plain && (input.key === "Enter" || input.key === "Escape")) {
          const accept = input.key === "Enter";
          const promptText =
            accept && dialog.type === "prompt" ? (tab.dialogPromptText ?? undefined) : undefined;
          const answered = yield* Effect.promise(() => tab.page.answerDialog(accept, promptText));
          tab.dialogPromptText = null;
          yield* notify;
          if (!answered) {
            return yield* rejectUrl("The dialog had already closed; take a snapshot to continue.");
          }
          return { tab, result: { tabId: tab.tabId } };
        }
      }
      if (request.operation === "type" && dialog.type === "prompt") {
        const input = request.input as PreviewAutomationTypeInput;
        yield* guardEgress(request.threadId, { kind: "type", page: webOrigin(tab.page.url()) });
        tab.dialogPromptText = input.text;
        return { tab, result: { tabId: tab.tabId } };
      }
      return yield* Effect.fail(dialogOpenError(dialog));
    });

  /** Fails as soon as a dialog opens on `page`; never completes otherwise. */
  const dialogOpens = (page: BrowserPage) =>
    Effect.callback<never, HostOperationError>((resume) => {
      // The op may have opened it before this side of the race subscribed.
      const already = page.pendingDialog();
      if (already !== null) {
        resume(Effect.fail(dialogOpenError(already)));
        return;
      }
      const unsubscribe = page.onDialogChange((dialog) => {
        if (dialog !== null) resume(Effect.fail(dialogOpenError(dialog)));
      });
      return Effect.sync(unsubscribe);
    });

  const runOperation = (request: PreviewAutomationRequest) =>
    Effect.gen(function* () {
      const timeoutMs = driverTimeoutFor(request.timeoutMs);
      switch (request.operation) {
        case "open": {
          const input = request.input as PreviewAutomationOpenInput;
          const resolved = input.url === undefined ? undefined : resolveBrowserUrl(input.url);
          if (resolved !== undefined && !resolved.ok) return yield* rejectUrl(resolved.reason);
          const url = resolved?.ok ? resolved.url : undefined;
          if (url !== undefined) {
            yield* guardEgress(request.threadId, { kind: "navigate", target: webOrigin(url) });
          }
          const reused = input.reuseExistingTab === false ? undefined : tabForRequest(request);
          const reusedDialog = reused?.page.pendingDialog() ?? null;
          if (url !== undefined && reusedDialog !== null) {
            return yield* Effect.fail(dialogOpenError(reusedDialog));
          }
          const tab = reused ?? (yield* createTab(request.threadId, url));
          if (url !== undefined) {
            yield* navigateTab(tab, url, "load", timeoutMs);
            runFork(logBotCheckLanding(tab));
          }
          yield* setActive(tab);
          yield* syncPreviewStatus(tab);
          return { tab, result: statusOf(tab) };
        }
        case "navigate": {
          const input = request.input as PreviewAutomationNavigateInput;
          const resolved =
            input.target !== undefined
              ? resolveBrowserNavigationTarget(input.target)
              : resolveBrowserUrl(input.url ?? "");
          if (!resolved.ok) return yield* rejectUrl(resolved.reason);
          yield* guardEgress(request.threadId, {
            kind: "navigate",
            target: webOrigin(resolved.url),
          });
          // Navigating a thread with no tab yet opens one, like a fresh browser window.
          const tab = tabForRequest(request) ?? (yield* createTab(request.threadId, resolved.url));
          const pending = tab.page.pendingDialog();
          if (pending !== null) return yield* Effect.fail(dialogOpenError(pending));
          yield* navigateTab(
            tab,
            resolved.url,
            input.readiness ?? "load",
            driverTimeoutFor(request.timeoutMs, input.timeoutMs),
          );
          runFork(logBotCheckLanding(tab));
          yield* setActive(tab);
          yield* syncPreviewStatus(tab);
          return { tab, result: statusOf(tab) };
        }
        case "closeTab": {
          // Only a tab this chat opened, named explicitly: an inherited "current tab" is never closed by accident.
          const tab = request.tabIdExplicit === true ? tabForRequest(request) : undefined;
          if (tab === undefined) {
            return yield* Effect.fail(
              new HostOperationError(
                "PreviewAutomationTabNotFoundError",
                "No open tab with that tabId in this chat's browser. Use preview_status or preview_open to see your tabs.",
              ),
            );
          }
          // A tab with a dialog open or a saved login filled can still be closed: closing reads nothing.
          yield* Effect.promise(() => tab.page.close().catch(() => undefined));
          yield* onTabPageClosed(tab);
          const remainingTabIds = [...runtime.tabs.values()]
            .filter((entry) => entry.threadId === request.threadId && openPage(entry.page))
            .map((entry) => entry.tabId);
          return {
            tab,
            result: { tabId: null, closedTabId: tab.tabId, remainingTabIds },
          };
        }
        default:
          break;
      }
      const tab = yield* requireTab(request);
      const pendingDialog = tab.page.pendingDialog();
      if (pendingDialog !== null) return yield* operateOnDialog(request, tab, pendingDialog);
      refreshCredentialProtection(tab);
      yield* setActive(tab);
      if (request.operation === "evaluate") {
        const refusal = loginScriptRefusal(openPage(tab.page) ? tab.page.url() : "");
        if (refusal !== null) return yield* rejectUrl(refusal);
      }
      if (
        tab.loginProtected &&
        (request.operation === "snapshot" ||
          request.operation === "type" ||
          request.operation === "waitFor")
      ) {
        return yield* rejectUrl(
          "This tab contains a saved login, so page reads, queries, and model-provided typing are disabled. Submit the form, then open a new tab to continue.",
        );
      }
      // Text typed here could be submitted to this page's origin, and a page
      // script can read and fetch() anywhere in one call.
      if (request.operation === "type" || request.operation === "press") {
        yield* guardEgress(request.threadId, { kind: "type", page: webOrigin(tab.page.url()) });
      } else if (request.operation === "evaluate") {
        yield* guardEgress(request.threadId, { kind: "script", page: webOrigin(tab.page.url()) });
      }
      switch (request.operation) {
        case "snapshot": {
          const snapshot = yield* attempt({}, () => captureSnapshot(tab.page, tab.timeline));
          tab.title = snapshot.title;
          return { tab, result: snapshot };
        }
        case "click": {
          const input = request.input as PreviewAutomationClickInput;
          if (tab.loginProtected && (input.locator !== undefined || input.selector !== undefined)) {
            return yield* rejectUrl(
              "Locator clicks are disabled after a saved login is filled. Use a button's coordinates captured before use_login, or press Enter.",
            );
          }
          // Same rule as preview_press: nothing but the plainest input reaches a tab holding a credential.
          if (
            tab.loginProtected &&
            ((input.button ?? "left") !== "left" || (input.modifiers?.length ?? 0) > 0)
          ) {
            return yield* rejectUrl(
              "Only plain left clicks are allowed after a saved login is filled: no right or middle button and no held keys.",
            );
          }
          yield* attempt(input, () =>
            performClick(tab.page, input, driverTimeoutFor(request.timeoutMs, input.timeoutMs)),
          );
          return { tab, result: { tabId: tab.tabId } };
        }
        case "hover": {
          const input = request.input as PreviewAutomationHoverInput;
          if (tab.loginProtected && (input.locator !== undefined || input.selector !== undefined)) {
            return yield* rejectUrl(
              "Locator hovers are disabled after a saved login is filled. Use a point's coordinates captured before use_login.",
            );
          }
          yield* attempt(input, () =>
            performHover(tab.page, input, driverTimeoutFor(request.timeoutMs, input.timeoutMs)),
          );
          return { tab, result: { tabId: tab.tabId } };
        }
        case "drag": {
          const input = request.input as PreviewAutomationDragInput;
          if (
            tab.loginProtected &&
            (input.fromLocator !== undefined || input.toLocator !== undefined)
          ) {
            return yield* rejectUrl(
              "Locator drags are disabled after a saved login is filled. Use coordinates captured before use_login.",
            );
          }
          yield* attempt({ locator: input.fromLocator }, () =>
            performDrag(tab.page, input, driverTimeoutFor(request.timeoutMs, input.timeoutMs)),
          );
          return { tab, result: { tabId: tab.tabId } };
        }
        case "history": {
          const input = request.input as PreviewAutomationHistoryInput;
          // A reload re-sends the form and back/forward can restore the filled document from cache.
          if (tab.loginProtected) {
            return yield* rejectUrl(
              "This tab contains a saved login, so back, forward and reload are disabled. Submit the form, then open a new tab to continue.",
            );
          }
          // Where the page is about to go counts as a navigation for the sensitive-site guard.
          const action = input.action;
          const destination =
            action === "reload"
              ? tab.page.url()
              : yield* attempt({}, () => tab.page.historyTarget(action));
          yield* guardEgress(request.threadId, {
            kind: "navigate",
            target: destination === null ? null : webOrigin(destination),
          });
          yield* attempt({}, () =>
            performHistory(tab.page, input, driverTimeoutFor(request.timeoutMs, input.timeoutMs)),
          );
          // A script a bot ran stays a risk here: back and forward can restore the old document from cache.
          runFork(logBotCheckLanding(tab));
          yield* syncPreviewStatus(tab);
          return { tab, result: statusOf(tab) };
        }
        case "type": {
          const input = request.input as PreviewAutomationTypeInput;
          yield* attempt(input, () =>
            performType(tab.page, input, driverTimeoutFor(request.timeoutMs, input.timeoutMs)),
          );
          return { tab, result: { tabId: tab.tabId } };
        }
        case "press": {
          const input = request.input as PreviewAutomationPressInput;
          const modifiers = new Set(input.modifiers ?? []);
          const clipboardShortcut =
            (/^(c|v|x)$/i.test(input.key) && (modifiers.has("Control") || modifiers.has("Meta"))) ||
            (input.key === "Insert" && (modifiers.has("Control") || modifiers.has("Shift"))) ||
            (input.key === "Delete" && modifiers.has("Shift"));
          if (clipboardShortcut) {
            return yield* rejectUrl(
              "Clipboard shortcuts are disabled in the shared bot browser to protect saved logins.",
            );
          }
          if (tab.loginProtected && (input.modifiers?.length ?? 0) > 0 && input.key !== "Tab") {
            return yield* rejectUrl(
              "Only ordinary Tab or Enter keys are allowed after a saved login is filled.",
            );
          }
          if (tab.loginProtected && input.key !== "Tab" && input.key !== "Enter") {
            return yield* rejectUrl("Only Tab or Enter is allowed after a saved login is filled.");
          }
          yield* attempt({}, () => performPress(tab.page, input));
          return { tab, result: { tabId: tab.tabId } };
        }
        case "scroll": {
          const input = request.input as PreviewAutomationScrollInput;
          if (tab.loginProtected && (input.locator !== undefined || input.selector !== undefined)) {
            return yield* rejectUrl(
              "Locator queries are disabled after a saved login is filled. Scroll the viewport instead.",
            );
          }
          yield* attempt(input, () => performScroll(tab.page, input, timeoutMs));
          return { tab, result: { tabId: tab.tabId } };
        }
        case "evaluate": {
          const input = request.input as PreviewAutomationEvaluateInput;
          // The tab's URL was checked above, but the page can navigate to a
          // signed-in site before the script reaches it, so the page checks
          // again in the same turn that runs the script.
          const scopes = loginCookieScopes(runtime.loginOrigins);
          if (scopes === null) return yield* rejectUrl(LOGIN_SCRIPTS_DISABLED_EVERYWHERE);
          const guarded =
            scopes.length === 0
              ? input
              : { ...input, expression: guardedExpression(input.expression, scopes) };
          yield* taintForScript(tab);
          return {
            tab,
            result: yield* attempt({}, () => performEvaluate(tab.page, guarded, timeoutMs)).pipe(
              Effect.mapError((error) =>
                error.message.includes(LOGIN_SCRIPT_REFUSED)
                  ? new HostOperationError(
                      "PreviewAutomationExecutionError",
                      "Page scripts are disabled on this page because it moved to a site where a saved login was used. Nothing was run.",
                    )
                  : error,
              ),
            ),
          };
        }
        case "waitFor": {
          const input = request.input as PreviewAutomationWaitForInput;
          yield* attempt(input, () =>
            performWaitFor(tab.page, input, driverTimeoutFor(request.timeoutMs, input.timeoutMs)),
          );
          return { tab, result: { tabId: tab.tabId } };
        }
        case "resize": {
          const input = request.input as PreviewAutomationResizeInput;
          const setting = yield* Effect.try({
            try: () => resolvePreviewViewport(input),
            catch: (cause) => classifyPageError(cause),
          });
          const override =
            setting._tag === "fill" ? null : { width: setting.width, height: setting.height };
          yield* attempt({}, () => tab.page.setViewport(override));
          if (override === null) agentViewports.delete(tab.page);
          else agentViewports.set(tab.page, override);
          yield* previewManager
            .resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting })
            .pipe(Effect.ignore);
          const viewport = yield* attempt({}, () => tab.page.viewportSize());
          return {
            tab,
            result: {
              tabId: tab.tabId,
              setting,
              viewport: {
                width: Math.max(1, Math.round(viewport.width)),
                height: Math.max(1, Math.round(viewport.height)),
              },
            },
          };
        }
        case "setColorScheme": {
          const input = request.input as PreviewAutomationSetColorSchemeInput;
          yield* attempt({}, () =>
            tab.page.setColorScheme(input.colorScheme === "system" ? null : input.colorScheme),
          );
          return { tab, result: { tabId: tab.tabId, colorScheme: input.colorScheme } };
        }
        default:
          return yield* Effect.fail(
            new HostOperationError(
              "PreviewAutomationUnsupportedClientError",
              `The server browser does not support ${request.operation}.`,
            ),
          );
      }
    });

  const describeOperation = (request: PreviewAutomationRequest, tab: TabEntry | undefined) => {
    const input = (request.input ?? {}) as Record<string, unknown>;
    const target = typeof input.locator === "string" ? input.locator : input.selector;
    switch (request.operation) {
      case "open":
      case "navigate":
        return tab !== undefined && openPage(tab.page) && /^https?:/i.test(tab.page.url())
          ? `Opened ${hostOf(tab.page.url())}`
          : "Opened a browser tab";
      case "snapshot":
        return tab?.title ? `Checked ${tab.title.slice(0, 60)}` : "Checked the page";
      case "click":
        return typeof target === "string" ? `Clicked ${target.slice(0, 60)}` : "Clicked the page";
      case "hover":
        return typeof target === "string" ? `Hovered ${target.slice(0, 60)}` : "Hovered the page";
      case "drag":
        return "Dragged on the page";
      case "history":
        return input.action === "back"
          ? "Went back"
          : input.action === "forward"
            ? "Went forward"
            : "Reloaded the page";
      case "closeTab":
        return "Closed a browser tab";
      case "type":
        return "Typed into the page";
      case "press":
        return `Pressed ${String(input.key ?? "a key")}`;
      case "scroll":
        return "Scrolled the page";
      case "evaluate":
        return "Ran a page script";
      case "waitFor":
        return "Waited for the page";
      case "resize":
        return "Resized the viewport";
      case "setColorScheme":
        return `Switched to ${String(input.colorScheme ?? "system")} appearance`;
      default:
        return request.operation;
    }
  };

  const isDriverTimeout = (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    return error instanceof HostOperationError && error.tag === "PreviewAutomationTimeoutError";
  };

  /**
   * After a timeout, make sure the page answers again: a script spinning on
   * its main thread would otherwise time out every later call on the tab.
   */
  const unstickPage = (page: BrowserPage) =>
    Effect.promise(() => page.unstick(UNSTICK_PROBE_MS).catch(() => "unresponsive" as const)).pipe(
      Effect.flatMap((outcome) =>
        outcome === "responsive"
          ? Effect.void
          : Effect.logWarning("Personal browser page stalled after a timed-out operation.", {
              outcome,
            }),
      ),
      Effect.andThen(notify),
    );

  const handleAutomationRequest: PersonalBrowser["Service"]["handleAutomationRequest"] = (
    incoming,
  ) => {
    // A saved key never goes into a web page: a bot with a shell can read an
    // env-mode key, and typing it into a form (or a prompt dialog) would hand it
    // to the site. The page gets "[secret NAME]" instead.
    const request = withoutTypedSecrets(incoming);
    // Fast path: status never launches Chrome, never takes the lease and
    // never waits behind an in-flight op (MCP gives it a 500ms budget).
    if (request.operation === "status")
      return Effect.sync(() => redactor.redact(statusOf(tabForRequest(request))));
    const execute = Effect.gen(function* () {
      yield* clearHelpForAgentSwitch(request.threadId);
      const startedAt = yield* nowIso;
      // Belt and braces: no operation may outlive its own budget while
      // holding the lease, even one whose driver call ignores timeouts, and
      // the budget ends before the broker's so the host is never evicted.
      // (Effect.timeoutFail does not exist in this Effect version; a
      // timeoutOption mapped to the broker's timeout tag is equivalent.)
      yield* refreshSensitiveOrigins;
      // A dialog opened by this very op (a click on a delete button, a
      // navigation away from a page with unsaved work) parks the page, and
      // the driver call would wait out its whole timeout. Report it at once.
      const target = tabForRequest(request);
      const watched =
        target !== undefined && target.page.pendingDialog() === null
          ? Effect.raceFirst(runOperation(request), dialogOpens(target.page))
          : runOperation(request);
      let timedOut = false;
      const bounded = watched.pipe(
        Effect.timeoutOption(Math.max(0, request.timeoutMs - HOST_REPLY_MARGIN_MS)),
        Effect.flatMap((result) => {
          if (Option.isSome(result)) return Effect.succeed(result.value);
          timedOut = true;
          return Effect.fail(
            new HostOperationError(
              "PreviewAutomationTimeoutError",
              `Browser operation timed out after ${request.timeoutMs}ms. The browser is ` +
                "checking the page and stops a stuck script; take a snapshot to continue.",
            ),
          );
        }),
      );
      const exit = yield* Effect.exit(Effect.andThen(ensureLaunched, bounded));
      const stalled = Exit.isFailure(exit) && (timedOut || isDriverTimeout(exit.cause));
      if (stalled && target !== undefined && openPage(target.page)) {
        // Off the reply path: the broker is waiting on this answer.
        runFork(unstickPage(target.page));
      }
      const tab = Exit.isSuccess(exit) ? exit.value.tab : tabForRequest(request);
      // Whatever the op returned, the bot has now had this page open; a failed
      // or timed-out op may still have loaded it.
      if (tab !== undefined && openPage(tab.page)) {
        yield* exposeIfSensitive(request.threadId, tab.page.url());
      }
      const completedAt = yield* nowIso;
      if (tab !== undefined) {
        tab.timeline.push({
          id: NodeCrypto.randomUUID(),
          action: request.operation,
          status: Exit.isSuccess(exit) ? "succeeded" : "failed",
          startedAt,
          completedAt,
          ...(Exit.isFailure(exit)
            ? { error: redactor.redactText(firstLine(String(Cause.squash(exit.cause)))) }
            : {}),
        });
        if (tab.timeline.length > TIMELINE_LIMIT)
          tab.timeline.splice(0, tab.timeline.length - TIMELINE_LIMIT);
      }
      const bot = yield* botForThread(request.threadId);
      yield* recordActivity({
        kind: request.operation as PersonalBrowserActivityKind,
        summary: describeOperation(request, tab),
        status: Exit.isSuccess(exit) ? "succeeded" : "failed",
        threadId: request.threadId,
        botName: bot?.name ?? null,
      });
      // Remember the page for a post-restart reopen. Only real pages count:
      // about:blank and chrome:// URLs would restore to nothing useful.
      // A URL carrying a filled password is not worth reopening; the lease
      // keeps the page before it instead of persisting the value.
      if (Exit.isSuccess(exit) && openPage(exit.value.tab.page)) {
        const current = safeUrl(exit.value.tab, exit.value.tab.page.url());
        if (/^https?:\/\//i.test(current) && redactor.redactText(current) === current) {
          yield* lease.recordPageUrl(current);
        }
      }
      return yield* Exit.match(exit, {
        onSuccess: ({ result }) => Effect.succeed(redactor.redact(result as unknown)),
        onFailure: (cause) => Effect.failCause(cause).pipe(Effect.mapError(redactError)),
      });
    });
    return lease
      .runAgentOp({ threadId: request.threadId, operation: request.operation }, execute)
      .pipe(
        Effect.catchTag("BrowserLeaseRejected", (rejected) =>
          Effect.fail(
            new HostOperationError("PreviewAutomationControlInterruptedError", rejected.message),
          ),
        ),
        Effect.ensuring(
          Effect.andThen(
            notify,
            // The "<bot> is using the browser" line clears once the lease lapses.
            Effect.sync(() =>
              runFork(Effect.andThen(Effect.sleep(AGENT_LEASE_TTL_MS + 250), notify)),
            ),
          ),
        ),
      );
  };

  return { gotoReplacing, handleAutomationRequest, navigateTab };
};

export type BrowserOperations = ReturnType<typeof makeBrowserOperations>;
