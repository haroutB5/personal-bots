// @effect-diagnostics nodeBuiltinImport:off - same node access as PersonalBrowser.ts (profile lock, artifacts).
// Who holds the browser: saved-login fills, the person taking control, help requests and the grace watchdog.
import * as NodeCrypto from "node:crypto";
import {
  PersonalBrowserError,
  ThreadId,
  type PersonalBrowserHelpRequest,
  type PersonalTaskId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { loginOriginCovering } from "./loginOrigins.ts";
import { HostOperationError, performFillLogin } from "./pageOperations.ts";
import { resolveBrowserUrl } from "./urlPolicy.ts";
import {
  CONTROL_CHECK_INTERVAL_MS,
  CONTROL_GRACE_MS,
  FILL_NAVIGATE_TIMEOUT_MS,
  QUEUED_HELP_NOTE,
  TIMELINE_LIMIT,
} from "./browserShared.ts";
import { DESKTOP_APPROVAL_KEY, type BrowserCore } from "./browserCore.ts";
import type { BrowserLaunch } from "./browserLaunch.ts";
import type { BrowserTabs } from "./browserTabs.ts";
import type { BrowserOperations } from "./browserOperations.ts";
import type { PersonalBrowser } from "./PersonalBrowser.ts";
import { stepControlWatch } from "./browserControlPolicy.ts";

export const makeBrowserControl = (
  core: BrowserCore,
  launch: BrowserLaunch,
  tabs: BrowserTabs,
  operations: BrowserOperations,
) =>
  Effect.gen(function* () {
    const {
      activateHelp,
      approvalQuestion,
      botForThread,
      exposeIfSensitive,
      lease,
      notify,
      nowIso,
      openPage,
      options,
      oneShotApprovals,
      refusedApprovals,
      originOf,
      pendingApprovals,
      pendingApprovalAt,
      persistProtections,
      promoteNextHelp,
      recordActivity,
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
          // A retry while the card is open returns the same card, whatever
          // holds the browser: a desktop pause may never have taken it.
          if (st.activeHelp?.request.threadId === input.threadId) return st.activeHelp.request;
          // Already queued: the bot is parked and will be resumed when its
          // card comes up. Tell it the same thing again rather than queue twice.
          if (st.helpQueue.some((entry) => entry.request.threadId === input.threadId)) {
            return yield* Effect.fail(
              new HostOperationError("PreviewAutomationControlInterruptedError", QUEUED_HELP_NOTE),
            );
          }
          const waitsForCard = st.activeHelp !== null;
          const view = yield* lease.view;
          // A desktop screenshot can pause a thread that never took the
          // browser lease; its server-recorded approval is enough to open the
          // same card. Everything else still needs the browser's controller.
          const pendingBefore = pendingApprovals.get(input.threadId) ?? null;
          if (
            !waitsForCard &&
            pendingBefore === null &&
            (view.ownerType !== "agent" ||
              view.ownerId !== input.threadId ||
              !view.agentActive ||
              view.takeoverPending)
          ) {
            return yield* Effect.fail(
              new HostOperationError(
                "PreviewAutomationControlInterruptedError",
                "Only the thread currently controlling the shared browser can request browser help.",
              ),
            );
          }
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
          pendingApprovalAt.delete(input.threadId);
          const request: PersonalBrowserHelpRequest = {
            threadId: input.threadId,
            botId: input.botId,
            botName: input.botName,
            reason: approval === null ? input.reason : approvalQuestion(approval),
            requestedAt: yield* nowIso,
            ...(approval === null
              ? {
                  // Only a real pending step makes a request "sensitive". A
                  // bot that labels its own request that way used to get an
                  // Allow once / Refuse card with nothing to decide (QA L1).
                  ...(input.kind === undefined
                    ? {}
                    : { kind: input.kind === "sensitive" ? ("other" as const) : input.kind }),
                  ...(input.origin === undefined ? {} : { origin: input.origin }),
                }
              : {
                  kind: "sensitive" as const,
                  destination: approval.destination,
                  sources: [...approval.sources],
                  // The card is answered on the Computer screen, not the
                  // browser panel: the reply wording differs.
                  ...(approval.key === DESKTOP_APPROVAL_KEY ? { surface: "desktop" as const } : {}),
                }),
          };
          const entry = { request, taskId: input.taskId, approval };
          // One card at a time (QA 28 Oct): a desktop pause skips the lease
          // check, so a second bot used to replace the open card and leave the
          // first parked with nobody ever answering it. It now waits its turn,
          // already parked, and is promoted when the active card closes.
          if (waitsForCard) {
            st.helpQueue.push(entry);
            yield* Effect.logInfo("personal browser help queued behind another card", {
              threadId: input.threadId,
              activeThreadId: st.activeHelp?.request.threadId ?? null,
              queued: st.helpQueue.length,
            });
            return yield* Effect.fail(
              new HostOperationError("PreviewAutomationControlInterruptedError", QUEUED_HELP_NOTE),
            );
          }
          yield* activateHelp(entry);
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
              // Once, never a standing permit: the same step asks again.
              oneShotApprovals.set(finishedHelp.request.threadId, approval.key);
            }
            yield* tasks
              .resumeFromUser({
                taskId: finishedHelp.taskId,
                noteId: `browser-help:${finishedHelp.request.requestedAt}`,
                note:
                  approval === null
                    ? "The user finished helping in the browser. Continue the task."
                    : `The user allowed this step once: ${approval.destination}. Retry that step now; any other destination still needs their approval.`,
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
          // The user is done with this card: the next queued bot gets it.
          yield* promoteNextHelp;
        }
        yield* notify;
        return yield* status(sessionId);
      });

    const returnToAgent: PersonalBrowser["Service"]["returnToAgent"] = (sessionId) =>
      returnControl(sessionId, null);

    /** The paused step for one thread: an active approval help, else a pending one. */
    const pausedStep = (threadId: string) => {
      const help = st.activeHelp;
      if (help !== null && help.request.threadId === threadId && help.approval !== null) {
        return {
          approval: help.approval,
          taskId: help.taskId,
          requestedAt: help.request.requestedAt,
        };
      }
      const approval = pendingApprovals.get(threadId);
      if (approval === undefined) return null;
      return {
        approval,
        taskId: null,
        requestedAt: pendingApprovalAt.get(threadId) ?? null,
      };
    };

    /**
     * Resumes the task a paused step belongs to. A pending approval recorded
     * before any card exists has no taskId, and a null resume used to leave
     * that task parked forever: fall back to the thread's current task, and if
     * it has none, clear the pause and say so (CTO's Bug 1 safety net).
     */
    const resumePausedTask = (
      threadId: string,
      taskId: PersonalTaskId | null,
      requestedAt: string | null,
      note: string,
    ) =>
      Effect.gen(function* () {
        let target = taskId;
        if (target === null) {
          const current = Option.flatten(
            yield* tasks.taskForThread({ threadId: ThreadId.make(threadId) }).pipe(Effect.option),
          );
          if (Option.isSome(current)) target = current.value.taskId;
        }
        if (target === null) {
          yield* Effect.logInfo("personal browser pause cleared with no live task to resume", {
            threadId,
          });
          return;
        }
        yield* tasks
          .resumeFromUser({
            taskId: target,
            noteId: `browser-help:${requestedAt ?? "pending"}`,
            note,
            restartSession: false,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("personal browser egress continuation could not be queued", {
                cause: Cause.pretty(cause),
              }),
            ),
          );
      });

    const approveEgress: PersonalBrowser["Service"]["approveEgress"] = (input) =>
      Effect.gen(function* () {
        const paused = pausedStep(input.threadId);
        if (paused === null) {
          return yield* Effect.fail(
            new HostOperationError(
              "PreviewAutomationExecutionError",
              "There is no paused step to allow for this bot. It may have moved on, or the pause was already decided.",
            ),
          );
        }
        // In memory, consumed by the next matching guardEgress.
        oneShotApprovals.set(input.threadId, paused.approval.key);
        pendingApprovals.delete(input.threadId);
        pendingApprovalAt.delete(input.threadId);
        const help = st.activeHelp;
        if (help !== null && help.request.threadId === input.threadId) st.activeHelp = null;
        yield* resumePausedTask(
          input.threadId,
          paused.taskId,
          paused.requestedAt,
          "The user allowed this step once. Retry the same action now.",
        );
        yield* promoteNextHelp;
        const bot = yield* botForThread(input.threadId);
        yield* recordActivity({
          kind: "control",
          summary: `allowed one step before ${paused.approval.destination}`,
          status: "succeeded",
          threadId: input.threadId,
          botName: help?.request.botName ?? bot?.name ?? null,
        });
        yield* notify;
        return yield* status(input.sessionId);
      }).pipe(Effect.mapError((error) => new PersonalBrowserError({ message: error.message })));

    const refuseEgress: PersonalBrowser["Service"]["refuseEgress"] = (input) =>
      Effect.gen(function* () {
        const paused = pausedStep(input.threadId);
        if (paused === null) {
          return yield* Effect.fail(
            new HostOperationError(
              "PreviewAutomationExecutionError",
              "There is no paused step to refuse for this bot. It may have moved on, or the pause was already decided.",
            ),
          );
        }
        oneShotApprovals.delete(input.threadId);
        // The same step stays refused for the rest of the turn, even if the
        // bot retries instead of taking the note.
        refusedApprovals.set(input.threadId, paused.approval.key);
        pendingApprovals.delete(input.threadId);
        pendingApprovalAt.delete(input.threadId);
        const help = st.activeHelp;
        if (help !== null && help.request.threadId === input.threadId) st.activeHelp = null;
        yield* resumePausedTask(
          input.threadId,
          paused.taskId,
          paused.requestedAt,
          "The user refused this step. Do not retry it; carry on without it.",
        );
        yield* promoteNextHelp;
        const bot = yield* botForThread(input.threadId);
        // The browser, the page and every other bot stay exactly as they are.
        yield* recordActivity({
          kind: "control",
          summary: `refused one step before ${paused.approval.destination}`,
          status: "succeeded",
          threadId: input.threadId,
          botName: help?.request.botName ?? bot?.name ?? null,
        });
        yield* notify;
        return yield* status(input.sessionId);
      }).pipe(Effect.mapError((error) => new PersonalBrowserError({ message: error.message })));

    const controlGraceMs = options.controlGraceMs ?? CONTROL_GRACE_MS;

    /**
     * Control goes back to the agent when the device that took it has been gone for the grace
     * period (a phone that locked or lost signal mid-control used to keep bots out for good).
     * Not while a bot's help request is open: that task waits for this person, who may finish on
     * the laptop itself.
     */
    const controlWatchdog = Effect.gen(function* () {
      const view = yield* lease.view;
      // The effect clock (a test clock moves it); reading it has no side effect.
      const nowMs = yield* Clock.currentTimeMillis;
      const step = stepControlWatch({
        graceMs: controlGraceMs,
        ownerType: view.ownerType,
        ownerId: view.ownerId,
        viewerSessionIds: [...viewers.values()].map((viewer) => viewer.sessionId),
        helpOpen: st.activeHelp !== null,
        state: { viewerSeen: st.controlViewerSeen, absentSince: st.controlAbsentSince },
        now: () => nowMs,
      });
      st.controlViewerSeen = step.state.viewerSeen;
      st.controlAbsentSince = step.state.absentSince;
      if (step.action !== "hand_back") return;
      yield* Effect.logInfo(
        "returning browser control to the agent: the device that had it disconnected",
        {
          seconds: Math.round(step.absentMs / 1_000),
        },
      );
      yield* returnControl(
        view.ownerId!,
        "Control went back to the agent: the device that had it disconnected",
      );
    });

    yield* Effect.forever(
      Effect.sleep(CONTROL_CHECK_INTERVAL_MS).pipe(
        Effect.andThen(controlWatchdog),
        Effect.ignoreCause({ log: true }),
      ),
    ).pipe(Effect.forkScoped);

    return {
      approveEgress,
      fillLogin,
      loginPage,
      refuseEgress,
      requestHelp,
      returnToAgent,
      takeControl,
    };
  });

export type BrowserControl = Effect.Success<ReturnType<typeof makeBrowserControl>>;
