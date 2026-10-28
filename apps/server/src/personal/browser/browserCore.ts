// @effect-diagnostics nodeBuiltinImport:off - same node access as PersonalBrowser.ts (profile lock, artifacts).
// The shared browser's parts that everything else stands on: its dependencies, the state of the
// session, the sensitive-site guard, the activity feed and the status the viewers see.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  ThreadId,
  type PersonalBotId,
  type PersonalBrowserActivityEvent,
  type PersonalBrowserActivityKind,
  type PersonalBrowserController,
  type PersonalBrowserHelpRequest,
  type PersonalBrowserStatus,
  type PersonalTaskId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerConfig from "../../config.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalLoginRepository from "../secrets/PersonalLoginRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import { BrowserLease, PERSONAL_BROWSER_PROFILE_ID } from "./BrowserLease.ts";
import { applyRequestedProfileReset } from "./browserProfileReset.ts";
import { makeCredentialRedactor } from "./credentialRedactor.ts";
import { type EgressApproval, type EgressIntent, egressNeedingApproval } from "./egressGuard.ts";
import {
  makeSensitiveExposureStore,
  rootExposureKey,
  type SensitiveExposureKind,
  threadExposureKey,
} from "./sensitiveExposureStore.ts";
import { type BrowserContextHandle, type BrowserPage, type ViewportSize } from "./driver.ts";
import { createMotionController } from "./adaptiveJpeg.ts";
import { BOT_CHECK_PROBE, classifyBotCheck, HostOperationError } from "./pageOperations.ts";
import {
  type BrowserProtectionState,
  PersonalBrowserProtectionRepository,
} from "./PersonalBrowserProtectionRepository.ts";
import {
  type Phase,
  RECENT_ACTIVITY_LIMIT,
  type TabEntry,
  type ViewerHandle,
  detectProfileLock,
  looksLikeLoginPage,
} from "./browserShared.ts";
import type { PersonalBrowserOptions } from "./PersonalBrowser.ts";
import type { PersonalBrowser } from "./PersonalBrowser.ts";

/** How a paused sensitive step starts its sentence; the activity feed uses it too. */
export const EGRESS_PAUSE_PREFIX = "Paused:";

/**
 * The desktop's approval key. It is not an origin: what a screenshot showed
 * can be typed or pasted into any app on the PC, so one approval covers one
 * action, never a destination that could be reused.
 */
export const DESKTOP_APPROVAL_KEY = "desktop-input";

export const makeBrowserCore = (rawOptions: PersonalBrowserOptions) =>
  Effect.gen(function* () {
    const options = rawOptions;
    const config = yield* ServerConfig.ServerConfig;
    const previewManager = yield* PreviewManager.PreviewManager;
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    const lease = yield* BrowserLease;
    const protections = yield* PersonalBrowserProtectionRepository;
    const runFork = yield* FiberSet.makeRuntime<never>();

    const profileDir = NodePath.join(config.baseDir, "personal", "browser-profiles", "default");
    const artifactsDir = config.browserArtifactsDir;
    const downloadsDir = NodePath.join(artifactsDir, "downloads");

    // Adapter-boundary state: mutated from Playwright callbacks as well as
    // effects, so it is plain and synchronous. Launch and screencast changes
    // are serialized by their own semaphores.
    const runtime = {
      phase: "offline" as Phase,
      detail: null as string | null,
      lockedByPid: null as number | null,
      context: null as BrowserContextHandle | null,
      contextSerial: 0,
      closing: false,
      tabs: new Map<string, TabEntry>(),
      activeTabId: null as string | null,
      loginUsed: false,
      // Origins a saved login was filled on. The profile keeps that session,
      // so page scripts stay disabled wherever its cookies can be read (see
      // loginOrigins.ts). `loginOriginsUnknown` is a profile that used a login
      // before the origins were recorded: page scripts stay disabled everywhere.
      loginOrigins: new Set<string>(),
      loginOriginsUnknown: false,
      // Origins where a model-provided script was allowed to run. A script can
      // register a service worker, which survives the tab, the navigation and
      // the Chrome process, so no saved login is ever filled on such an origin
      // again in this profile.
      taintedOrigins: new Set<string>(),
    };
    // Every password this process fills is masked in whatever leaves this
    // service afterwards: op results, errors, the timeline, the activity feed
    // and the page URL saved for a restart. See credentialRedactor.ts.
    const redactor = makeCredentialRedactor();
    const redactError = (error: HostOperationError) =>
      new HostOperationError(
        error.tag,
        redactor.redactText(error.message),
        redactor.redact(error.detail),
      );
    // An owner-approved reset swaps in an empty profile and clears the
    // protections of the old one. It only runs when its request file exists,
    // and before the protections below are read.
    yield* applyRequestedProfileReset({
      personalDir: NodePath.join(config.baseDir, "personal"),
      profileDir,
      profileId: PERSONAL_BROWSER_PROFILE_ID,
      now: yield* DateTime.now,
      isProfileLocked: async (dir) => (await detectProfileLock(dir)).locked,
      saveProtections: protections.save,
    });
    // Restored while the layer is still being built, so no tool call can reach
    // the shared browser before the protections that gate its persistent,
    // still-authenticated profile are back in place.
    const restored = yield* protections.load(PERSONAL_BROWSER_PROFILE_ID).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "Personal browser protections could not be read; starting with page scripts disabled.",
          { cause },
        ).pipe(
          // Failing open here would hand an unprotected authenticated profile
          // to the next bot, so an unreadable row is treated as "a login was
          // used", which is the restrictive answer.
          Effect.as(
            Option.some<BrowserProtectionState>({
              profileId: PERSONAL_BROWSER_PROFILE_ID,
              loginUsed: true,
              loginOrigins: null,
              taintedOrigins: [],
            }),
          ),
        ),
      ),
    );
    if (Option.isSome(restored)) {
      runtime.loginUsed = restored.value.loginUsed;
      runtime.loginOriginsUnknown =
        restored.value.loginUsed && restored.value.loginOrigins === null;
      for (const origin of restored.value.loginOrigins ?? []) runtime.loginOrigins.add(origin);
      for (const origin of restored.value.taintedOrigins) runtime.taintedOrigins.add(origin);
    }

    /**
     * Writes the whole protection state. Callers treat a failure as a refusal
     * rather than a warning: a protection that cannot be recorded would be
     * gone at the next restart while the profile stayed signed in.
     */
    const persistProtections = Effect.suspend(() =>
      protections.save({
        profileId: PERSONAL_BROWSER_PROFILE_ID,
        loginUsed: runtime.loginUsed,
        loginOrigins: runtime.loginOriginsUnknown ? null : [...runtime.loginOrigins],
        taintedOrigins: [...runtime.taintedOrigins],
      }),
    );

    const pageTitles = new WeakMap<BrowserPage, string>();
    const viewers = new Map<number, ViewerHandle>();
    /** One help card: the active one, or an entry waiting in line behind it. */
    type HelpEntry = {
      readonly request: PersonalBrowserHelpRequest;
      readonly taskId: PersonalTaskId;
      /** Set when this request is the user's approval for a guarded destination. */
      readonly approval: EgressApproval | null;
    };
    // Mutable state the parts of the service share. One object, so a part that lives in another
    // module reads and writes the same fields.
    const st: {
      viewerSequence: number;
      /**
       * Frames arrive on Playwright's callback, outside any effect, so the mask
       * reads a plain copy of who holds the browser. Every lease change refreshes
       * it; takeControl and returnToAgent also refresh it directly so the first
       * frame after either already sees the new owner.
       */
      humanInControl: boolean;
      /**
       * Whether the device that holds control has had a viewer attached since it took it (a lease
       * restored at boot counts: the restart cut its viewer). A person who took control and never
       * opened a live view may be typing into the laptop's Chrome window, so only a device that was
       * watching and then went away loses control.
       */
      controlViewerSeen: boolean;
      controlAbsentSince: number | null;
      /** One FramesHidden notice per hidden stretch; a forwarded frame ends it. */
      framesHidden: boolean;
      screencast: { readonly page: BrowserPage; readonly stop: () => Promise<void> } | null;
      lastPageInfoRefresh: number;
      /** What the controlling phone asked for, and where it is applied right now. */
      humanViewport: {
        readonly sessionId: string;
        readonly viewerId: number;
        readonly size: ViewportSize;
      } | null;
      appliedViewport: { readonly page: BrowserPage; readonly size: ViewportSize } | null;
      activeHelp: HelpEntry | null;
      /**
       * Bots that asked while another card was open, first come first served.
       * They are already parked on waiting_for_browser; promoting one shows
       * its card and the same Allow once / Refuse / hand-back resumes it.
       */
      helpQueue: HelpEntry[];
      sensitiveOrigins: ReadonlySet<string>;
      /** When the browser last closed; survives the teardown so the idle card can say it. */
      lastStop: string | null;
    } = {
      viewerSequence: 0,
      humanInControl: (yield* lease.view).ownerType === "human",
      controlViewerSeen: false,
      controlAbsentSince: null,
      framesHidden: false,
      screencast: null,
      lastPageInfoRefresh: 0,
      humanViewport: null,
      appliedViewport: null,
      activeHelp: null,
      helpQueue: [],
      sensitiveOrigins: new Set(),
      lastStop: null,
    };
    st.controlViewerSeen = st.humanInControl;
    // Frames arrive on Playwright's callback, outside any effect, so the mask
    // reads a plain copy of who holds the browser. Every lease change refreshes
    // it; takeControl and returnToAgent also refresh it directly so the first
    // frame after either already sees the new owner.
    // Whether the device that holds control has had a viewer attached since it took it (a lease
    // restored at boot counts: the restart cut its viewer). A person who took control and never
    // opened a live view may be typing into the laptop's Chrome window, so only a device that was
    // watching and then went away loses control.
    // One FramesHidden notice per hidden stretch; a forwarded frame ends it.
    // While the person scrolls, the screencast is rougher and smaller; a sharp frame follows the
    // scroll. It always begins sharp: a new screencast resets it.
    const motion =
      options.adaptiveJpeg === false
        ? null
        : createMotionController({
            ...(options.adaptiveSettleMs === undefined
              ? {}
              : { settleMs: options.adaptiveSettleMs }),
            apply: (profile) => {
              const current = st.screencast;
              return current?.page.setScreencastProfile?.(profile) ?? Promise.resolve();
            },
            onChange: (profile) => {
              for (const viewer of viewers.values()) viewer.telemetry?.motion(profile === "moving");
            },
          });
    // The agent's own preview_resize per page, so a human's phone viewport is
    // undone back to exactly what the agent chose rather than to the window.
    const agentViewports = new WeakMap<BrowserPage, ViewportSize>();
    // What the controlling phone asked for, and where it is applied right now.

    const launchLock = yield* Semaphore.make(1);
    const screencastLock = yield* Semaphore.make(1);
    const viewportLock = yield* Semaphore.make(1);
    const statusDirty = yield* PubSub.unbounded<void>();
    const activityPubSub = yield* PubSub.unbounded<PersonalBrowserActivityEvent>();
    const recent: PersonalBrowserActivityEvent[] = [];

    // Sensitive-site egress guard (policy in egressGuard.ts). What a bot has
    // had open is kept per thread and per delegation tree, since a delegated
    // brief can carry it. Persisted (sensitiveExposureStore.ts): the provider
    // session that saw the page is recovered with its resume cursor after a
    // restart, so a taint held in memory would be dropped while the model
    // still holds the page. It governs the shared browser and nothing else.
    const logins = yield* PersonalLoginRepository.PersonalLoginRepository;
    const exposureStore = makeSensitiveExposureStore(yield* SqlClient.SqlClient);
    // The approval a thread was refused for, until its next request_browser_help
    // turns it into the question the user actually sees.
    const pendingApprovals = new Map<string, EgressApproval>();
    /** When each pending approval was paused, for the UI's card. */
    const pendingApprovalAt = new Map<string, string>();
    /**
     * "Allow once": the next guardEgress for that thread whose key matches
     * consumes this and passes. In memory only, never the persistent exposure
     * store, so a second identical step asks again (SPEC.md 10.7).
     */
    const oneShotApprovals = new Map<string, string>();
    /**
     * "Refused": the same step fails for the rest of the turn instead of
     * pausing again, so Refuse works even when the user answers before the bot
     * has called request_browser_help. Cleared at turn end.
     */
    const refusedApprovals = new Map<string, string>();

    const refreshSensitiveOrigins = logins.sensitiveOrigins().pipe(
      Effect.map((origins) => {
        st.sensitiveOrigins = new Set(origins);
      }),
      Effect.catch((cause) =>
        Effect.logWarning("Sensitive sites could not be read; keeping the last known list.", {
          cause,
        }),
      ),
    );

    /** An http(s) origin, or null for about:blank and anything without one. */
    const webOrigin = (url: string): string | null => {
      try {
        const { origin } = new URL(url);
        return origin === "null" ? null : origin;
      } catch {
        return null;
      }
    };

    /**
     * A bot's navigation that lands on a human-check page is logged by origin (info, no path, no
     * page text), so it is easy to see which sites stop the browser. It runs after the navigation
     * has returned (up to a second of looking must not hold the bot's next step), and a failed or
     * slow look is just skipped: this never changes what the navigation returns.
     */
    const BOT_CHECK_PROBE_MS = 1_000;
    /** How long a replaced navigation that landed gets to finish loading before the bot is answered. */
    const REPLACED_NAVIGATION_LOAD_CAP_MS = 3_000;
    const logBotCheckLanding = (tab: TabEntry) =>
      Effect.gen(function* () {
        if (!openPage(tab.page)) return;
        const origin = webOrigin(tab.page.url());
        if (origin === null) return;
        const sample = yield* Effect.tryPromise({
          try: () => tab.page.evaluate(BOT_CHECK_PROBE),
          catch: () => undefined,
        }).pipe(
          Effect.timeoutOption(BOT_CHECK_PROBE_MS),
          Effect.map((result) => (Option.isSome(result) ? result.value : null)),
          Effect.orElseSucceed(() => null),
        );
        // The page may have moved on while it was being looked at (up to a second): the sample then
        // describes another site than the one named, so it is dropped rather than logged under it.
        if (!openPage(tab.page) || webOrigin(tab.page.url()) !== origin) return;
        const kind = classifyBotCheck(sample);
        if (kind !== null) yield* Effect.logInfo("browser landed on a bot check", { origin, kind });
      });

    /** A thread's own key, plus its delegation tree's when it works in one. */
    const exposureKeys = (threadId: string) =>
      tasks.rootTaskIdForThread(ThreadId.make(threadId)).pipe(
        Effect.map(
          Option.match({
            onNone: () => [threadExposureKey(threadId)],
            onSome: (root) => [threadExposureKey(threadId), rootExposureKey(root)],
          }),
        ),
        Effect.catchCause(() => Effect.succeed([threadExposureKey(threadId)])),
      );

    /**
     * Fails closed: a record that cannot be read is treated as carrying a
     * sensitive page, so a database hiccup never waves content through.
     */
    const exposureOf = (keys: ReadonlyArray<string>) =>
      exposureStore.read(keys).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Sensitive-site exposure could not be read; treating as exposed.", {
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.as({
              sources: new Set(["a sensitive site (its record could not be read)"]),
              approved: new Set<string>(),
            }),
          ),
        ),
      );

    const recordExposure = (
      keys: ReadonlyArray<string>,
      kind: SensitiveExposureKind,
      value: string,
    ) =>
      exposureStore.record(keys, kind, value).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Sensitive-site exposure could not be recorded.", {
            kind,
            value,
            cause: Cause.pretty(cause),
          }),
        ),
      );

    /** Remembers that the thread has had `url` open when it is a sensitive site. */
    const exposeIfSensitive = (threadId: string, url: string) =>
      Effect.gen(function* () {
        const origin = webOrigin(url);
        if (origin === null || !st.sensitiveOrigins.has(origin)) return;
        const keys = yield* exposureKeys(threadId);
        yield* recordExposure(keys, "source", origin);
      });

    /**
     * What the thread is currently carrying, for egress channels outside the
     * browser. Read-only: it never records, approves or refuses anything, so a
     * caller cannot use it to widen its own exposure.
     */
    const sensitiveExposure = (threadId: ThreadId): Effect.Effect<ReadonlyArray<string>> =>
      exposureKeys(threadId).pipe(
        Effect.flatMap(exposureOf),
        Effect.map((exposure) => [...exposure.sources].toSorted()),
      );

    /**
     * Refuses an action that needs the user's approval. The bot is told to
     * ask with request_browser_help; that request then shows the user this
     * server-written question instead of the bot's own reason.
     */
    const guardEgress = (threadId: string, intent: EgressIntent) =>
      Effect.gen(function* () {
        const keys = yield* exposureKeys(threadId);
        const approval = egressNeedingApproval({
          exposure: yield* exposureOf(keys),
          intent,
          sensitive: st.sensitiveOrigins,
        });
        if (approval === null) return;
        if (oneShotApprovals.get(threadId) === approval.key) {
          oneShotApprovals.delete(threadId);
          return;
        }
        if (refusedApprovals.get(threadId) === approval.key) {
          // The refusal lasts the turn: dropping it here made Refuse a
          // one-shot, so a retry paused again and could still get through.
          pendingApprovals.delete(threadId);
          pendingApprovalAt.delete(threadId);
          return yield* Effect.fail(
            new HostOperationError(
              "PreviewAutomationExecutionError",
              "The user refused this step. Do not retry it; carry on without it.",
            ),
          );
        }
        pendingApprovals.set(threadId, approval);
        pendingApprovalAt.set(threadId, yield* nowIso);
        return yield* Effect.fail(
          new HostOperationError(
            "PreviewAutomationExecutionError",
            `${EGRESS_PAUSE_PREFIX} this could carry what you saw on ${approval.sources.join(", ")} (a site the user marked sensitive) to ${approval.destination}. Call request_browser_help now with a one-line reason, tell the user in one sentence what you want to do, then end your turn. You continue automatically if they approve; do not try another route.`,
          ),
        );
      });

    const approvalQuestion = (approval: EgressApproval) =>
      `Allow sending what the bot saw on ${approval.sources.join(", ")} to ${approval.destination}? Choose Allow once to let this one step through, or Refuse to skip it.`;

    const recordDesktopExposure: PersonalBrowser["Service"]["recordDesktopExposure"] = (input) =>
      Effect.gen(function* () {
        const keys = yield* exposureKeys(input.threadId);
        yield* recordExposure(keys, "source", input.value);
      });

    const guardDesktopInput: PersonalBrowser["Service"]["guardDesktopInput"] = (input) =>
      Effect.gen(function* () {
        const keys = yield* exposureKeys(input.threadId);
        const sources = [...(yield* exposureOf(keys)).sources].toSorted();
        if (sources.length === 0) return;
        if (oneShotApprovals.get(input.threadId) === DESKTOP_APPROVAL_KEY) {
          oneShotApprovals.delete(input.threadId);
          return;
        }
        if (refusedApprovals.get(input.threadId) === DESKTOP_APPROVAL_KEY) {
          pendingApprovals.delete(input.threadId);
          pendingApprovalAt.delete(input.threadId);
          return yield* Effect.fail(
            new HostOperationError(
              "PreviewAutomationExecutionError",
              "The user refused this step. Do not retry it; carry on without it.",
            ),
          );
        }
        const approval: EgressApproval = {
          key: DESKTOP_APPROVAL_KEY,
          sources,
          destination: "another app on this PC",
        };
        pendingApprovals.set(input.threadId, approval);
        pendingApprovalAt.set(input.threadId, yield* nowIso);
        return yield* Effect.fail(
          new HostOperationError(
            "PreviewAutomationExecutionError",
            `${EGRESS_PAUSE_PREFIX} this could carry what you saw on ${sources.join(", ")} (a site the user marked sensitive) to ${approval.destination}. Call request_browser_help now with a one-line reason, tell the user in one sentence what you want to do, then end your turn. You continue automatically if they approve; do not try another route.`,
          ),
        );
      });

    const notify = PubSub.publish(statusDirty, undefined).pipe(Effect.asVoid);

    /**
     * Ends a help request the user never finished and resumes the bot with
     * `note`. The task is parked on waiting_for_browser until something resumes
     * it, so every way a request can disappear other than Return to bot has to
     * come through here, or the task waits forever.
     */
    const abandonHelp = (note: string) =>
      Effect.gen(function* () {
        const pending = st.activeHelp;
        if (pending === null) return;
        st.activeHelp = null;
        yield* tasks
          .resumeFromUser({
            taskId: pending.taskId,
            noteId: `browser-help:${pending.request.requestedAt}:ended`,
            note,
            restartSession: false,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("personal browser help could not be ended", {
                threadId: pending.request.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        yield* promoteNextHelp;
      });

    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const recordActivity = Effect.fn("PersonalBrowser.recordActivity")(function* (input: {
      readonly kind: PersonalBrowserActivityKind;
      readonly summary: string;
      readonly status: PersonalBrowserActivityEvent["status"];
      readonly threadId: ThreadId | null;
      readonly botName: string | null;
    }) {
      const event: PersonalBrowserActivityEvent = {
        ...input,
        summary: redactor.redactText(input.summary),
        id: NodeCrypto.randomUUID(),
        at: yield* nowIso,
      };
      recent.push(event);
      if (recent.length > RECENT_ACTIVITY_LIMIT)
        recent.splice(0, recent.length - RECENT_ACTIVITY_LIMIT);
      yield* PubSub.publish(activityPubSub, event);
    });

    /** How often a waiting card refreshes the lease it is keeping (90 s TTL). */
    const HELP_LEASE_REFRESH_MS = 30_000;

    /**
     * A card can wait minutes on the user, and the agent lease lives 90 s
     * without a heartbeat. While the question is open the thread keeps its
     * place with a quiet refresh, so the lease cannot lapse and let the next
     * bot cancel the card the user is answering (QA's B2).
     */
    const keepLeaseWhileAsking = (threadId: string) =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(HELP_LEASE_REFRESH_MS);
          const help = st.activeHelp;
          if (help === null || help.request.threadId !== threadId) return;
          yield* lease
            .runAgentOp({ threadId, operation: "help-wait" }, Effect.void)
            .pipe(Effect.ignore);
        }
      });

    /** Shows one card and gives its waiting thread the usual lease heartbeat. */
    const activateHelp = (entry: HelpEntry) =>
      Effect.gen(function* () {
        st.activeHelp = entry;
        runFork(Effect.ignore(keepLeaseWhileAsking(entry.request.threadId)));
        yield* recordActivity({
          kind: "control",
          summary: `asked for help: ${entry.request.reason}`,
          status: "succeeded",
          threadId: entry.request.threadId,
          botName: entry.request.botName,
        });
        yield* notify;
      });

    /**
     * The next card in line, shown as soon as the active one is gone (answered,
     * refused, handed back, cancelled, or its task ended). A queued bot was
     * already parked by requestHelp, so this only makes the card visible; the
     * same decision paths resume it through its stored taskId.
     */
    const promoteNextHelp: Effect.Effect<void> = Effect.gen(function* () {
      if (st.activeHelp !== null) return;
      const next = st.helpQueue.shift();
      if (next === undefined) return;
      yield* activateHelp(next);
    });

    /**
     * A task reached a terminal state: its card is not a question any more and
     * its thread's queued entries can never be answered. Clear both and promote
     * whoever is next. No resume: the task is already over.
     */
    const clearTaskHelp = (input: {
      readonly threadId: ThreadId | null;
      readonly taskId?: PersonalTaskId;
    }) =>
      Effect.gen(function* () {
        const matches = (entry: HelpEntry) =>
          (input.taskId !== undefined && entry.taskId === input.taskId) ||
          (input.threadId !== null && entry.request.threadId === input.threadId);
        const active = st.activeHelp;
        const clearedActive = active !== null && matches(active);
        if (clearedActive) st.activeHelp = null;
        const before = st.helpQueue.length;
        st.helpQueue = st.helpQueue.filter((entry) => !matches(entry));
        const clearedQueued = before - st.helpQueue.length;
        if (!clearedActive && clearedQueued === 0) return;
        yield* Effect.logInfo("personal browser help cleared when its task ended", {
          threadId: input.threadId,
          taskId: input.taskId,
          clearedActive,
          clearedQueued,
        });
        yield* notify;
        yield* promoteNextHelp;
      });

    /** Drops a thread's cards without resuming anything (its task is gone). */
    const clearHelpForThread = (threadId: ThreadId) => clearTaskHelp({ threadId });

    const botForThread = (threadId: string) =>
      bots.getThreadLink({ threadId: ThreadId.make(threadId) }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(null),
            onSome: (link) =>
              bots.getBotById({ botId: link.botId }).pipe(
                Effect.map((bot) => ({
                  botId: link.botId as PersonalBotId,
                  name: Option.isSome(bot) ? bot.value.name : null,
                })),
              ),
          }),
        ),
        Effect.orElseSucceed(() => null),
      );

    const openPage = (page: BrowserPage | null | undefined): page is BrowserPage =>
      page !== null && page !== undefined && !page.isClosed();

    const originOf = (url: string): string | null => {
      try {
        return new URL(url).origin;
      } catch {
        return null;
      }
    };

    const ownedPages = () => new Set([...runtime.tabs.values()].map((tab) => tab.page));

    /** The page the viewport shows: the active agent tab, else any open page. */
    const viewportPage = (): BrowserPage | null => {
      const active =
        runtime.activeTabId === null ? undefined : runtime.tabs.get(runtime.activeTabId);
      if (openPage(active?.page)) return active.page;
      return runtime.context?.pages().find((page) => !page.isClosed()) ?? null;
    };

    /** The panel draws a page's dialog, so it hears about it opening and closing. */
    const dialogWatched = new WeakSet<BrowserPage>();
    const watchDialogs = (page: BrowserPage) => {
      if (dialogWatched.has(page)) return;
      dialogWatched.add(page);
      page.onDialogChange(() => runFork(notify));
    };

    const titleFor = (page: BrowserPage) => {
      for (const tab of runtime.tabs.values()) if (tab.page === page) return tab.title;
      return pageTitles.get(page) ?? "";
    };

    /**
     * The Computer tab's card: the ACTIVE help entry's approval, and nothing
     * else. A pending approval that has not been asked about yet belongs to a
     * bot with no card on screen; falling back to "any pending pause" is how a
     * queued bot's decision card used to replace the card the user was reading
     * (QA's Bug 2). The active card is help or pause, never a queue entry.
     */
    const egressPauseFor = Effect.sync(() => {
      const help = st.activeHelp;
      if (help === null || help.approval === null) return null;
      return {
        threadId: help.request.threadId,
        botId: help.request.botId,
        botName: help.request.botName,
        sources: [...help.approval.sources],
        destination: help.approval.destination,
        requestedAt: help.request.requestedAt,
      };
    });

    /** Bots queued for the lease, named for "Up next". */
    const waitingClaimants = Effect.gen(function* () {
      const queued = yield* lease.waiting;
      const claimants = [];
      for (const entry of queued) {
        const bot = yield* botForThread(entry.threadId);
        if (bot === null) continue;
        claimants.push({
          threadId: entry.threadId,
          botId: bot.botId,
          botName: bot.name ?? "A bot",
        });
      }
      return claimants;
    });

    const status: PersonalBrowser["Service"]["status"] = (sessionId) =>
      Effect.gen(function* () {
        const view = yield* lease.view;
        let controller: PersonalBrowserController = { _tag: "None" };
        if (view.ownerType === "human") {
          controller = {
            _tag: "Human",
            self: view.ownerId === sessionId,
            connected: [...viewers.values()].some((viewer) => viewer.sessionId === view.ownerId),
          };
        } else if (view.agentActive && view.ownerId !== null) {
          const bot = yield* botForThread(view.ownerId);
          controller = {
            _tag: "Agent",
            threadId: ThreadId.make(view.ownerId),
            botId: bot?.botId ?? null,
            botName: bot?.name ?? null,
          };
        }
        // Survives the 90s agent TTL and a human takeover, so the Computer
        // tab's Back can still name the chat that opened the browser. A help
        // request outranks it: that chat is the one waiting on the user.
        const backThreadId: string | null =
          st.activeHelp?.request.threadId ?? view.lastAgentThreadId;
        let lastAgent: PersonalBrowserStatus["lastAgent"] = null;
        if (backThreadId !== null) {
          const bot = yield* botForThread(backThreadId);
          if (bot !== null) {
            lastAgent = { threadId: ThreadId.make(backThreadId), botId: bot.botId };
          }
        }
        const page = runtime.phase === "connected" ? viewportPage() : null;
        const viewportTab =
          page === null ? undefined : [...runtime.tabs.values()].find((tab) => tab.page === page);
        const pageInfo =
          page === null
            ? null
            : redactor.redact({
                url: viewportTab === undefined ? page.url() : safeUrl(viewportTab, page.url()),
                title: titleFor(page),
              });
        return {
          state:
            runtime.phase === "connected" && pageInfo !== null && looksLikeLoginPage(pageInfo.url)
              ? "waiting_for_login"
              : runtime.phase,
          detail: runtime.detail,
          lockedByPid: runtime.lockedByPid,
          controller,
          generation: view.generation,
          page: pageInfo,
          helpRequest: st.activeHelp?.request ?? null,
          waiting: yield* waitingClaimants,
          egressPause: yield* egressPauseFor,
          dialog: page === null ? null : redactor.redact(page.pendingDialog()),
          lastAgent,
          lastStop: st.lastStop,
          viewers: viewers.size,
        } satisfies PersonalBrowserStatus;
      });

    const refreshPageInfo = Effect.gen(function* () {
      const page = viewportPage();
      if (page === null) return;
      const title = yield* Effect.promise(() => page.title().catch(() => titleFor(page)));
      const tab = [...runtime.tabs.values()].find((entry) => entry.page === page);
      const previous = titleFor(page);
      if (tab !== undefined) tab.title = title;
      else pageTitles.set(page, title);
      if (previous !== title) yield* notify;
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
    const refreshCredentialProtection = (tab: TabEntry | undefined): void => {
      if (tab === undefined || tab.credentialFormUrl === null || !openPage(tab.page)) return;
      const current = tab.page.url();
      if (current === tab.credentialFormUrl) return;
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        return;
      }
      if (parsed.search !== "" || parsed.hash !== "") return;
      tab.credentialFormUrl = null;
      tab.loginProtected = false;
    };

    /** Protected tabs never publish a query string: a GET login form puts the password there. */
    const safeUrl = (tab: TabEntry, url: string): string => {
      if (!tab.loginProtected) return url;
      try {
        const parsed = new URL(url);
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return url;
      }
    };

    return {
      REPLACED_NAVIGATION_LOAD_CAP_MS,
      abandonHelp,
      activateHelp,
      activityPubSub,
      agentViewports,
      approvalQuestion,
      artifactsDir,
      botForThread,
      clearHelpForThread,
      clearTaskHelp,
      downloadsDir,
      exposeIfSensitive,
      exposureKeys,
      guardEgress,
      launchLock,
      lease,
      logBotCheckLanding,
      motion,
      notify,
      nowIso,
      openPage,
      options,
      originOf,
      ownedPages,
      pendingApprovals,
      pendingApprovalAt,
      oneShotApprovals,
      promoteNextHelp,
      refusedApprovals,
      persistProtections,
      previewManager,
      profileDir,
      recent,
      recordActivity,
      recordExposure,
      redactError,
      redactor,
      refreshCredentialProtection,
      refreshPageInfo,
      refreshSensitiveOrigins,
      restored,
      runFork,
      runtime,
      safeUrl,
      screencastLock,
      sensitiveExposure,
      recordDesktopExposure,
      guardDesktopInput,
      st,
      status,
      statusDirty,
      tasks,
      viewers,
      viewportLock,
      viewportPage,
      watchDialogs,
      webOrigin,
    };
  });

export type BrowserCore = Effect.Success<ReturnType<typeof makeBrowserCore>>;
