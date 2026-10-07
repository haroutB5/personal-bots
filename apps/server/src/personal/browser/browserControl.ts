// @effect-diagnostics nodeBuiltinImport:off - same node access as PersonalBrowser.ts (profile lock, artifacts).
// Who holds the browser: saved-login fills, the person taking control, help requests and the grace watchdog.
import * as NodeCrypto from "node:crypto";
import { type PersonalBrowserHelpRequest } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { loginOriginCovering } from "./loginOrigins.ts";
import { HostOperationError, performFillLogin } from "./pageOperations.ts";
import { resolveBrowserUrl } from "./urlPolicy.ts";
import {
  CONTROL_CHECK_INTERVAL_MS,
  CONTROL_GRACE_MS,
  FILL_NAVIGATE_TIMEOUT_MS,
  TIMELINE_LIMIT,
} from "./browserShared.ts";
import type { BrowserCore } from "./browserCore.ts";
import type { BrowserLaunch } from "./browserLaunch.ts";
import type { BrowserTabs } from "./browserTabs.ts";
import type { BrowserOperations } from "./browserOperations.ts";
import type { PersonalBrowser } from "./PersonalBrowser.ts";

export const makeBrowserControl = (
  core: BrowserCore,
  launch: BrowserLaunch,
  tabs: BrowserTabs,
  operations: BrowserOperations,
) =>
  Effect.gen(function* () {
    const {
      approvalQuestion,
      botForThread,
      exposeIfSensitive,
      exposureKeys,
      lease,
      notify,
      nowIso,
      openPage,
      options,
      originOf,
      pendingApprovals,
      persistProtections,
      recordActivity,
      recordExposure,
      redactError,
      redactor,
      refreshSensitiveOrigins,
      runFork,
      runtime,
      safeUrl,
      st,
      status,
      tasks,
      viewers,
    } = core;
    const { ensureLaunched, syncHumanViewport } = launch;
    const {
      attempt,
      clearHelpForAgentSwitch,
      createTab,
      latestTabForThread,
      retireTabsInCookieScope,
      setActive,
    } = tabs;
    const { navigateTab } = operations;

    const loginPage: PersonalBrowser["Service"]["loginPage"] = (threadId) =>
      Effect.sync(() => {
        const tab = latestTabForThread(threadId);
        if (tab === undefined || !openPage(tab.page)) return null;
        const origin = originOf(tab.page.url());
        return origin === null
          ? null
          : { tabId: `${tab.tabId}:${tab.loginOriginRevision}`, origin };
      });

    const fillLogin: PersonalBrowser["Service"]["fillLogin"] = (input) => {
      // Learned before any driver call, so even an error raised mid-fill that
      // echoes the value is masked on its way out.
      redactor.remember(input.password);
      redactor.remember(input.username);
      const execute = Effect.gen(function* () {
        yield* clearHelpForAgentSwitch(input.threadId);
        const source = latestTabForThread(input.threadId);
        if (source === undefined) {
          return yield* Effect.fail(
            new HostOperationError(
              "PreviewAutomationTabNotFoundError",
              "No open browser tab for this thread. Open the matching site first.",
            ),
          );
        }
        if (
          input.expectedTabId !== undefined &&
          input.expectedTabId !== `${source.tabId}:${source.loginOriginRevision}`
        ) {
          return yield* Effect.fail(
            new HostOperationError(
              "PreviewAutomationExecutionError",
              "Login origin mismatch: the requesting tab changed.",
            ),
          );
        }
        // The bot chooses the page, so its own tab still has to be on the
        // granted origin; it just never receives the credential itself.
        const sourceUrl = openPage(source.page) ? source.page.url() : "";
        const sourceOrigin = originOf(sourceUrl);
        if (sourceOrigin !== input.expectedOrigin) {
          return yield* Effect.fail(
            new HostOperationError(
              "PreviewAutomationExecutionError",
              `This saved login can only be used on ${input.expectedOrigin}; the current page origin is ${sourceOrigin ?? "unknown"}.`,
            ),
          );
        }
        // A model-provided script that ran on this origin may have registered a
        // service worker, which outlives the tab, the navigation and Chrome
        // itself and can read a later fill from inside the page. Nothing here
        // can undo that, so the origin is simply never filled again.
        // The same holds anywhere that shares this login's cookies: a script on
        // a sibling subdomain can read a domain cookie the login sets.
        const taintedInScope = [...runtime.taintedOrigins].find(
          (origin) => loginOriginCovering(origin, [input.expectedOrigin]) !== null,
        );
        if (taintedInScope !== undefined) {
          return yield* Effect.fail(
            new HostOperationError(
              "PreviewAutomationExecutionError",
              taintedInScope === input.expectedOrigin
                ? `A page script was run on ${input.expectedOrigin} in this browser, so saved logins are no longer filled there. Page state from that script can outlive the tab.`
                : `A page script was run on ${taintedInScope}, which shares cookies with ${input.expectedOrigin}, so saved logins are no longer filled there. Page state from that script can outlive the tab.`,
            ),
          );
        }
        // The credential goes into a tab this server just opened and navigated,
        // never into the one the bot has been driving: a script installed by an
        // earlier preview_evaluate lives in that document, and disabling later
        // evaluate calls does not remove it.
        const resolvedTarget = resolveBrowserUrl(sourceUrl);
        const target = resolvedTarget.ok ? resolvedTarget.url : `${input.expectedOrigin}/`;
        const tab = yield* createTab(input.threadId, target);
        yield* navigateTab(tab, target, "load", FILL_NAVIGATE_TIMEOUT_MS);
        yield* setActive(tab);
        // Protect before the first field is touched: a driver timeout can occur
        // after inserting some or all of a value, and must not reopen model reads.
        // The bit intentionally survives navigation for the tab's lifetime.
        tab.loginProtected = true;
        tab.credentialFormUrl = openPage(tab.page) ? tab.page.url() : target;
        runtime.loginUsed = true;
        runtime.loginOrigins.add(input.expectedOrigin);
        // A protection that is only in memory would be gone after a restart
        // while the profile stayed signed in, so the fill waits for the write.
        yield* persistProtections.pipe(
          Effect.mapError(
            () =>
              new HostOperationError(
                "PreviewAutomationExecutionError",
                "The browser protections for this login could not be recorded, so it was not filled.",
              ),
          ),
        );
        // Every tab in this login's cookie scope is retired with the fill, the
        // bot's own and other threads': they can hold script a bot installed,
        // and closing the bot's own also routes its next tool call to the tab
        // the server opened rather than the old one.
        yield* retireTabsInCookieScope({ origin: input.expectedOrigin, except: tab });
        const fields = yield* attempt({}, () =>
          performFillLogin(
            tab.page,
            {
              expectedOrigin: input.expectedOrigin,
              username: input.username,
              password: input.password,
            },
            10_000,
          ),
        );
        return { tab, fields };
      });
      return lease
        .runAgentOp(
          { threadId: input.threadId, operation: "type" },
          Effect.andThen(ensureLaunched, execute),
        )
        .pipe(
          Effect.tap(({ tab }) =>
            Effect.gen(function* () {
              // Signed in on a sensitive site: the page after this is its account.
              yield* refreshSensitiveOrigins;
              yield* exposeIfSensitive(input.threadId, input.expectedOrigin);
              tab.timeline.push({
                id: NodeCrypto.randomUUID(),
                action: "type",
                status: "succeeded",
                startedAt: yield* nowIso,
                completedAt: yield* nowIso,
              });
              if (tab.timeline.length > TIMELINE_LIMIT)
                tab.timeline.splice(0, tab.timeline.length - TIMELINE_LIMIT);
              const bot = yield* botForThread(input.threadId);
              // Origin equality ignores the path and the model picks the page,
              // so the user's activity line names where the credential went.
              const filledAt = openPage(tab.page) ? safeUrl(tab, tab.page.url()) : null;
              yield* recordActivity({
                kind: "type",
                summary:
                  filledAt === null
                    ? `Filled the saved login "${input.label}"`
                    : `Filled the saved login "${input.label}" on ${filledAt.slice(0, 200)}`,
                status: "succeeded",
                threadId: input.threadId,
                botName: bot?.name ?? null,
              });
            }),
          ),
          Effect.map(({ fields }) => fields),
          Effect.catchTag("BrowserLeaseRejected", (rejected) =>
            Effect.fail(
              new HostOperationError("PreviewAutomationControlInterruptedError", rejected.message),
            ),
          ),
          Effect.mapError(redactError),
          Effect.ensuring(notify),
        );
    };

    const takeControl: PersonalBrowser["Service"]["takeControl"] = (sessionId) =>
      Effect.gen(function* () {
        const before = yield* lease.view;
        yield* lease.takeControl(sessionId);
        st.humanInControl = true;
        st.controlViewerSeen = [...viewers.values()].some(
          (viewer) => viewer.sessionId === sessionId,
        );
        st.controlAbsentSince = null;
        // Another device taking over drops the previous controller's phone viewport.
        yield* syncHumanViewport;
        if (!(before.ownerType === "human" && before.ownerId === sessionId)) {
          yield* recordActivity({
            kind: "control",
            summary: "You took control",
            status: "succeeded",
            threadId: null,
            botName: null,
          });
        }
        // Taking control of a browser that is not running starts it.
        if (runtime.phase !== "connected" && runtime.phase !== "starting") {
          runFork(Effect.ignore(ensureLaunched));
        }
        yield* notify;
        return yield* status(sessionId);
      });

    const requestHelp: PersonalBrowser["Service"]["requestHelp"] = (input) =>
      lease.runExclusive(
        Effect.gen(function* () {
          const view = yield* lease.view;
          if (
            view.ownerType !== "agent" ||
            view.ownerId !== input.threadId ||
            !view.agentActive ||
            view.takeoverPending
          ) {
            return yield* Effect.fail(
              new HostOperationError(
                "PreviewAutomationControlInterruptedError",
                "Only the thread currently controlling the shared browser can request browser help.",
              ),
            );
          }
          if (st.activeHelp?.request.threadId === input.threadId) return st.activeHelp.request;
          yield* tasks
            .waitForBrowser({ taskId: input.taskId })
            .pipe(
              Effect.mapError(
                (error) => new HostOperationError("PreviewAutomationExecutionError", error.message),
              ),
            );
          // A pending approval replaces whatever the bot wrote: the user decides
          // on the server's account of where the data would go, not the page's.
          const approval = pendingApprovals.get(input.threadId) ?? null;
          pendingApprovals.delete(input.threadId);
          const request: PersonalBrowserHelpRequest = {
            threadId: input.threadId,
            botId: input.botId,
            botName: input.botName,
            reason: approval === null ? input.reason : approvalQuestion(approval),
            requestedAt: yield* nowIso,
          };
          st.activeHelp = { request, taskId: input.taskId, approval };
          yield* recordActivity({
            kind: "control",
            summary: `${input.botName} asked for help: ${request.reason}`,
            status: "succeeded",
            threadId: input.threadId,
            botName: input.botName,
          });
          yield* notify;
          return request;
        }),
      );

    /** Gives control back to the agent; `summary` words the activity line when nobody asked for it by hand. */
    const returnControl = (sessionId: string, summary: string | null) =>
      Effect.gen(function* () {
        const before = yield* lease.view;
        yield* lease.returnToAgent;
        st.humanInControl = (yield* lease.view).ownerType === "human";
        st.controlViewerSeen = false;
        st.controlAbsentSince = null;
        // The agent gets its own viewport back before it can run another op.
        yield* syncHumanViewport;
        if (before.ownerType === "human") {
          const finishedHelp = st.activeHelp;
          st.activeHelp = null;
          yield* recordActivity({
            kind: "control",
            summary:
              finishedHelp === null
                ? (summary ?? "Returned control to the agent")
                : "You finished helping",
            status: "succeeded",
            threadId: finishedHelp?.request.threadId ?? null,
            botName: finishedHelp?.request.botName ?? null,
          });
          if (finishedHelp !== null) {
            const approval = finishedHelp.approval;
            if (approval !== null) {
              const keys = yield* exposureKeys(finishedHelp.request.threadId);
              yield* recordExposure(keys, "approved", approval.key);
            }
            yield* tasks
              .resumeFromUser({
                taskId: finishedHelp.taskId,
                noteId: `browser-help:${finishedHelp.request.requestedAt}`,
                note:
                  approval === null
                    ? "The user finished helping in the browser. Continue the task."
                    : `The user approved ${approval.destination}. Retry that step; any other destination still needs their approval.`,
                restartSession: false,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("personal browser help continuation could not be queued", {
                    threadId: finishedHelp.request.threadId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
          }
        }
        yield* notify;
        return yield* status(sessionId);
      });

    const returnToAgent: PersonalBrowser["Service"]["returnToAgent"] = (sessionId) =>
      returnControl(sessionId, null);

    const controlGraceMs = options.controlGraceMs ?? CONTROL_GRACE_MS;

    /**
     * Control goes back to the agent when the device that took it has been gone for the grace
     * period (a phone that locked or lost signal mid-control used to keep bots out for good).
     * Not while a bot's help request is open: that task waits for this person, who may finish on
     * the laptop itself.
     */
    const controlWatchdog = Effect.gen(function* () {
      const view = yield* lease.view;
      if (controlGraceMs <= 0 || view.ownerType !== "human" || view.ownerId === null) {
        st.controlAbsentSince = null;
        return;
      }
      const owner = view.ownerId;
      if ([...viewers.values()].some((viewer) => viewer.sessionId === owner)) {
        st.controlViewerSeen = true;
        st.controlAbsentSince = null;
        return;
      }
      if (!st.controlViewerSeen || st.activeHelp !== null) {
        st.controlAbsentSince = null;
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      st.controlAbsentSince ??= now;
      if (now - st.controlAbsentSince < controlGraceMs) return;
      yield* Effect.logInfo(
        "returning browser control to the agent: the device that had it disconnected",
        {
          seconds: Math.round((now - st.controlAbsentSince) / 1_000),
        },
      );
      yield* returnControl(
        owner,
        "Control went back to the agent: the device that had it disconnected",
      );
    });

    yield* Effect.forever(
      Effect.sleep(CONTROL_CHECK_INTERVAL_MS).pipe(
        Effect.andThen(controlWatchdog),
        Effect.ignoreCause({ log: true }),
      ),
    ).pipe(Effect.forkScoped);

    return { fillLogin, loginPage, requestHelp, returnToAgent, takeControl };
  });

export type BrowserControl = Effect.Success<ReturnType<typeof makeBrowserControl>>;
