// Chrome's own life: the live screencast to the viewers, the phone's viewport and launching the browser.
import { encodePersonalBrowserFrame } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  type BrowserContextHandle,
  type BrowserPage,
  type ScreencastMeta,
  type ViewportOverride,
} from "./driver.ts";
import { HostOperationError } from "./pageOperations.ts";
import {
  offerFrameToFlows,
  untilAnyFlowTookFrame,
  VIEWER_FLOW_LIMITS,
  ViewerFlow,
} from "./viewerFlow.ts";
import {
  FRAMES_HIDDEN_REASON,
  HELP_ENDED_BY_CLOSE,
  HELP_ENDED_BY_CRASH,
  HELP_ENDED_BY_SWITCH,
  PAGE_INFO_REFRESH_MS,
  PHONE_DEVICE_SCALE_FACTOR,
  PersonalBrowserLaunchError,
  detectProfileLock,
  encodeViewerMessage,
  firstLine,
} from "./browserShared.ts";
import type { BrowserCore } from "./browserCore.ts";

export const makeBrowserLaunch = (core: BrowserCore) =>
  Effect.gen(function* () {
    const {
      abandonHelp,
      agentViewports,
      downloadsDir,
      launchLock,
      lease,
      motion,
      notify,
      openPage,
      options,
      previewManager,
      profileDir,
      recordActivity,
      refreshCredentialProtection,
      refreshPageInfo,
      runFork,
      runtime,
      screencastLock,
      st,
      viewers,
      viewportLock,
      viewportPage,
      watchDialogs,
    } = core;

    /**
     * Hands a frame to every phone and returns what Chrome's ack for it waits for: the
     * moment some phone has written it, a newer frame has overwritten it or it was
     * dropped (at most a short cap). The ack must not wait for anything else. Holding
     * every frame's ack until the next write (1.60.35) left Chrome, which keeps at
     * most two frames unacknowledged, idle between our writes: it rendered 22 frames
     * a second and we sent 9. Replaced frames are useless, so their ack goes at once
     * and Chrome keeps rendering; the newest frame is the one that goes out.
     * Kill switch `T3CODE_PERSONAL_BROWSER_FRAME_ACK_EARLY=off`: the old holding.
     */
    const offerToViewers = (frame: Uint8Array): Promise<void> | undefined => {
      const flows = [...viewers.values()].map((viewer) => viewer.flow);
      if (flows.length === 0) return undefined;
      if (options.frameAckEarly === false) {
        for (const flow of flows) flow.offerFrame(frame);
        return untilViewerTookFrame(flows);
      }
      let released: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        released = resolve;
      });
      const heldAt = performance.now();
      offerFrameToFlows(flows, frame, released);
      for (const viewer of viewers.values()) viewer.telemetry?.chromeHeld();
      return Effect.runPromise(
        Effect.raceFirst(
          Effect.promise(() => done),
          Effect.sleep(VIEWER_FLOW_LIMITS.chromeHoldMs),
        ),
      ).then(() => recordHold(heldAt));
    };

    const recordHold = (heldAt: number) => {
      const heldMs = performance.now() - heldAt;
      const capped = heldMs >= VIEWER_FLOW_LIMITS.chromeHoldMs - 2;
      for (const viewer of viewers.values()) viewer.telemetry?.chromeHold(heldMs, capped);
    };

    /** The 1.60.35 holding, kept behind its kill switch: the ack waits until some phone has no pending frame. */
    const untilViewerTookFrame = (flows: ReadonlyArray<ViewerFlow>): Promise<void> | undefined => {
      if (flows.some((flow) => !flow.hasPending)) return undefined;
      const heldAt = performance.now();
      for (const viewer of viewers.values()) viewer.telemetry?.chromeHeld();
      return Effect.runPromise(untilAnyFlowTookFrame(flows, VIEWER_FLOW_LIMITS.chromeHoldMs)).then(
        () => recordHold(heldAt),
      );
    };

    /**
     * Forwards one screencast frame to every attached phone, unless it shows
     * the credential form a bot just filled while a bot (not a person) holds
     * the browser: a reveal-password widget would stream the plaintext. The
     * whole form stretch is withheld rather than guessing focus or reveal
     * state, since either would mean reading the page. Take control always
     * streams; it is the person's own screen, and they need it to type.
     */
    const onFrame = (page: BrowserPage, jpeg: Uint8Array, meta: ScreencastMeta) => {
      const tab = [...runtime.tabs.values()].find((entry) => entry.page === page);
      refreshCredentialProtection(tab);
      let handedOff: Promise<void> | undefined;
      for (const viewer of viewers.values()) viewer.telemetry?.chromeFrame();
      if (tab?.loginProtected === true && !st.humanInControl) {
        for (const viewer of viewers.values()) viewer.telemetry?.frameHidden();
        if (!st.framesHidden) {
          st.framesHidden = true;
          const notice = encodeViewerMessage({
            _tag: "FramesHidden",
            reason: FRAMES_HIDDEN_REASON,
          });
          for (const viewer of viewers.values()) Queue.offerUnsafe(viewer.outbox, notice);
        }
        // A frame still waiting for the link was taken before the form was filled.
        for (const viewer of viewers.values()) viewer.flow.dropPending();
      } else {
        st.framesHidden = false;
        const frame = encodePersonalBrowserFrame(jpeg, meta);
        handedOff = offerToViewers(frame);
      }
      // Frames only arrive when the page repaints, so they double as a cheap
      // trigger for noticing human navigation (url/title) without polling.
      const now = performance.now();
      if (now - st.lastPageInfoRefresh > PAGE_INFO_REFRESH_MS) {
        st.lastPageInfoRefresh = now;
        runFork(Effect.andThen(refreshPageInfo, notify));
      }
      return handedOff;
    };

    /** Screencast runs exactly while a viewer is attached to a live page. */
    const syncScreencast = screencastLock.withPermit(
      Effect.gen(function* () {
        const target = viewers.size > 0 && runtime.phase === "connected" ? viewportPage() : null;
        if (st.screencast !== null && (target === null || st.screencast.page !== target)) {
          const { stop } = st.screencast;
          st.screencast = null;
          motion?.reset();
          yield* Effect.promise(() => stop().catch(() => undefined));
        }
        if (target !== null) watchDialogs(target);
        if (target !== null && st.screencast === null) {
          const stop = yield* Effect.tryPromise(() =>
            target.startScreencast((jpeg, meta) => onFrame(target, jpeg, meta)),
          ).pipe(Effect.option);
          if (Option.isSome(stop)) st.screencast = { page: target, stop: stop.value };
          motion?.reset();
        }
      }),
    );

    /**
     * Stops the screencast on `page` and lets syncScreencast start a new one.
     * A screencast reads the page's device scale once, when it starts, so a
     * metrics change needs a fresh one for the frames to match it.
     */
    const restartScreencastOn = (page: BrowserPage) =>
      screencastLock
        .withPermit(
          Effect.gen(function* () {
            if (st.screencast === null || st.screencast.page !== page) return;
            const { stop } = st.screencast;
            st.screencast = null;
            motion?.reset();
            yield* Effect.promise(() => stop().catch(() => undefined));
          }),
        )
        .pipe(Effect.andThen(syncScreencast));

    const setPageViewport = (page: BrowserPage, size: ViewportOverride | null) =>
      Effect.promise(() =>
        page.setViewport(size).then(
          () => true,
          () => false,
        ),
      );

    /**
     * Reconciles the phone viewport with who holds the browser. It is applied
     * to the viewport page only while the session that asked for it holds
     * human control and the viewer it came from is still attached. Otherwise
     * the page gets back exactly what it had: the agent's own preview_resize,
     * or no override at all. It follows the viewport page, so a tab change
     * takes it off the old tab instead of leaving that tab phone-sized.
     */
    const syncHumanViewport = viewportLock.withPermit(
      Effect.gen(function* () {
        const view = yield* lease.view;
        const held =
          st.humanViewport !== null &&
          view.ownerType === "human" &&
          view.ownerId === st.humanViewport.sessionId &&
          viewers.has(st.humanViewport.viewerId)
            ? st.humanViewport
            : null;
        st.humanViewport = held;
        const target = held !== null && runtime.phase === "connected" ? viewportPage() : null;
        const current = st.appliedViewport;
        if (
          current !== null &&
          held !== null &&
          current.page === target &&
          current.size.width === held.size.width &&
          current.size.height === held.size.height
        ) {
          return;
        }
        if (current !== null) {
          st.appliedViewport = null;
          if (current.page !== target && openPage(current.page)) {
            yield* setPageViewport(current.page, agentViewports.get(current.page) ?? null);
            yield* restartScreencastOn(current.page);
          }
        }
        if (held !== null && target !== null) {
          const applied = yield* setPageViewport(target, {
            ...held.size,
            deviceScaleFactor: PHONE_DEVICE_SCALE_FACTOR,
            mobile: true,
          });
          if (applied) st.appliedViewport = { page: target, size: held.size };
          yield* restartScreencastOn(target);
        }
      }),
    );

    // Every way a context ends (Chrome exiting, the deliberate teardown, the
    // server shutting down) reports it; the set keeps that to one line each.
    const summarisedContexts = new WeakSet<BrowserContextHandle>();
    /** One line per launch: counts only, never a URL. */
    const logAdblockSummary = (context: BrowserContextHandle | null) =>
      Effect.gen(function* () {
        if (context === null || summarisedContexts.has(context)) return;
        const adblock = context.adblockStats?.();
        if (adblock?.enabled !== true) return;
        summarisedContexts.add(context);
        yield* Effect.logInfo("browser ad blocking summary", {
          rules: adblock.rules,
          requests: adblock.requests,
          blocked: adblock.blocked,
        });
      });

    const onContextClosed = (serial: number) =>
      Effect.gen(function* () {
        if (serial !== runtime.contextSerial) return;
        const tabs = [...runtime.tabs.values()];
        yield* logAdblockSummary(runtime.context);
        runtime.context = null;
        runtime.tabs.clear();
        runtime.activeTabId = null;
        st.screencast = null;
        // Its page died with Chrome; a relaunch re-applies it if still wanted.
        st.appliedViewport = null;
        motion?.reset();
        runtime.phase = runtime.closing ? "offline" : "crashed";
        runtime.detail = runtime.closing
          ? null
          : "Chrome exited. It restarts on the next browser action or when you take control.";
        yield* abandonHelp(runtime.closing ? HELP_ENDED_BY_CLOSE : HELP_ENDED_BY_CRASH);
        yield* Effect.forEach(
          tabs,
          (tab) =>
            previewManager.close({ threadId: tab.threadId, tabId: tab.tabId }).pipe(Effect.ignore),
          { discard: true },
        );
        yield* notify;
      });

    const ensureLaunched = launchLock.withPermit(
      Effect.gen(function* () {
        if (runtime.context !== null && runtime.phase === "connected") return runtime.context;
        runtime.phase = "starting";
        runtime.detail = null;
        runtime.lockedByPid = null;
        yield* notify;
        const exit = yield* Effect.exit(
          Effect.tryPromise({
            try: () =>
              options.driver.launch({
                userDataDir: profileDir,
                headless: options.headless,
                executablePath: options.executablePath,
                downloadsDir,
                onDownloadSaved: (file) =>
                  runFork(
                    recordActivity({
                      kind: "download",
                      summary: `Downloaded ${file.name}`,
                      status: "succeeded",
                      threadId: null,
                      botName: null,
                    }),
                  ),
              }),
            // Keep Playwright's own error. The default wrapper replaces it with
            // "An error occurred in Effect.tryPromise", which hides the cause.
            catch: (cause) =>
              new PersonalBrowserLaunchError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }),
        );
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          const message =
            error instanceof PersonalBrowserLaunchError ? error.message : String(error);
          const lock = yield* Effect.promise(() => detectProfileLock(profileDir));
          const detail = lock.locked
            ? lock.pid === null
              ? "The browser profile is in use by another Chrome process."
              : `Locked by pid ${lock.pid}`
            : `Chrome failed to start: ${firstLine(message)}`;
          runtime.phase = lock.locked ? "locked" : "crashed";
          runtime.lockedByPid = lock.locked ? lock.pid : null;
          runtime.detail = detail;
          yield* Effect.logWarning("Personal browser launch failed.", { detail, error: message });
          yield* notify;
          return yield* Effect.fail(
            new HostOperationError("PreviewAutomationExecutionError", detail),
          );
        }
        const context = exit.value;
        const serial = ++runtime.contextSerial;
        runtime.context = context;
        context.onClose(() => runFork(onContextClosed(serial)));
        const adblock = context.adblockStats?.();
        yield* Effect.logInfo(
          adblock?.enabled === true ? "browser ad blocking is on" : "browser ad blocking is off",
          adblock?.enabled === true ? { rules: adblock.rules } : {},
        );
        runtime.phase = "connected";
        yield* notify;
        yield* syncScreencast;
        yield* syncHumanViewport;
        return context;
      }),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        runtime.closing = true;
        const context = runtime.context;
        yield* logAdblockSummary(context);
        yield* Effect.promise(async () => {
          await context?.close().catch(() => undefined);
        });
      }),
    );

    // Lease changes (takeover, return, agent switch) are status changes. A
    // human takeover keeps the request visible until control is returned; a
    // different agent taking the lease makes the old request stale.
    yield* lease.changes.pipe(
      Stream.runForEach((view) =>
        Effect.gen(function* () {
          st.humanInControl = view.ownerType === "human";
          if (
            st.activeHelp !== null &&
            view.ownerType === "agent" &&
            view.ownerId !== null &&
            view.ownerId !== st.activeHelp.request.threadId
          ) {
            yield* abandonHelp(HELP_ENDED_BY_SWITCH);
          }
          // Control moving anywhere else hands the page its own viewport back.
          yield* syncHumanViewport;
          yield* notify;
        }),
      ),
      Effect.forkScoped,
    );

    return { ensureLaunched, logAdblockSummary, syncHumanViewport, syncScreencast };
  });

export type BrowserLaunch = Effect.Success<ReturnType<typeof makeBrowserLaunch>>;
