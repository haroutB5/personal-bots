// The phone's live view: attaching a viewer and carrying its input to the page.
import {
  clampPersonalBrowserViewport,
  personalBrowserInputMovesFocus,
  PersonalBrowserInputMessage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { type BrowserPage } from "./driver.ts";
import { classifyPageError, HostOperationError } from "./pageOperations.ts";
import { resolveBrowserUrl } from "./urlPolicy.ts";
import {
  SCROLL_SETTLE_CAP_MS,
  SCROLL_SETTLE_WINDOW_MS,
  scrollSettleExpression,
  settleOutcome,
} from "./scrollSettle.ts";
import { type StreamInputKind, ViewerTelemetry } from "./streamTelemetry.ts";
import { ViewerFlow } from "./viewerFlow.ts";
import {
  type ViewerHandle,
  decodeInputMessage,
  encodeStreamLine,
  streamInputKind,
} from "./browserShared.ts";
import type { BrowserCore } from "./browserCore.ts";
import type { BrowserLaunch } from "./browserLaunch.ts";
import type { BrowserOperations } from "./browserOperations.ts";
import type { PersonalBrowser } from "./PersonalBrowser.ts";

export const makeBrowserViewers = (
  core: BrowserCore,
  launch: BrowserLaunch,
  operations: BrowserOperations,
) => {
  const { lease, motion, notify, options, runFork, runtime, st, viewers, viewportPage } = core;
  const { syncHumanViewport, syncScreencast } = launch;
  const { gotoReplacing } = operations;

  const attachViewer: PersonalBrowser["Service"]["attachViewer"] = (input) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const outbox = yield* Queue.unbounded<string>();
        const viewer: ViewerHandle = {
          id: ++st.viewerSequence,
          ...input,
          outbox,
          flow: new ViewerFlow({
            adaptiveWindow: options.adaptiveAckWindow !== false,
            ...(options.streamMaxFps === undefined ? {} : { maxFps: options.streamMaxFps }),
          }),
          telemetry:
            options.streamTelemetry === false
              ? null
              : new ViewerTelemetry({
                  viewerId: st.viewerSequence,
                  canOperate: input.canOperate,
                }),
          scrollEndHint: motion !== null,
        };
        if (viewer.telemetry !== null) viewer.flow.setObserver(viewer.telemetry);
        viewers.set(viewer.id, viewer);
        // A phone joining mid-stretch still gets the notice on the next frame.
        st.framesHidden = false;
        yield* syncScreencast;
        yield* notify;
        return viewer;
      }),
      (viewer) =>
        Effect.gen(function* () {
          viewers.delete(viewer.id);
          if (viewer.telemetry !== null) {
            yield* Effect.logInfo(
              `browser-stream summary ${encodeStreamLine(viewer.telemetry.summary())}`,
            );
          }
          // Lets a Chrome ack that was waiting on this phone go.
          viewer.flow.dropPending();
          yield* Queue.shutdown(viewer.outbox);
          // A phone that disconnects mid-control leaves the page as it found it.
          yield* syncHumanViewport;
          yield* syncScreencast;
          yield* notify;
        }),
    );

  /** How many inputs each viewer had refused, so the telemetry can tell a failed input. */
  const rejections = new WeakMap<ViewerHandle, number>();

  const rejectInput = (viewer: ViewerHandle, reason: string) =>
    Effect.sync(() => rejections.set(viewer, (rejections.get(viewer) ?? 0) + 1)).pipe(
      Effect.andThen(rejectInputNow(viewer, reason)),
    );

  const rejectInputNow = (viewer: ViewerHandle, reason: string) =>
    Queue.offer(viewer.outbox, JSON.stringify({ _tag: "InputRejected", reason })).pipe(
      Effect.asVoid,
    );

  /**
   * Which phone keyboard the focused element wants, or false for none.
   * Evaluated in the page rather than inferred from a hit test, so a custom
   * editor that moves focus in its own click handler is judged by where focus
   * actually ended up. It follows focus into open shadow roots and
   * same-origin frames, where sign-in and search fields often live; a
   * cross-origin frame hides its focus, and a tap into one (a hosted sign-in
   * or card form) most likely hit a field, so it counts as text.
   */
  const FOCUS_PROBE = `(() => {
      let element = document.activeElement;
      for (let depth = 0; depth < 10 && element; depth++) {
        if (element.shadowRoot && element.shadowRoot.activeElement) {
          element = element.shadowRoot.activeElement;
          continue;
        }
        if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
          let inner = null;
          try {
            inner = element.contentDocument ? element.contentDocument.activeElement : null;
          } catch (error) {
            inner = null;
          }
          if (!inner) return "text";
          if (inner === element.contentDocument.body) return false;
          element = inner;
          continue;
        }
        break;
      }
      if (!element || element === document.body) return false;
      if (element.isContentEditable === true) return "text";
      if (element.disabled === true || element.readOnly === true) return false;
      const tag = element.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA") return false;
      const mode = String(element.getAttribute("inputmode") || "").toLowerCase();
      if (["numeric","decimal","tel","email","url","search"].indexOf(mode) !== -1) return mode;
      if (tag === "TEXTAREA") return "text";
      const type = String(element.getAttribute("type") || "text").toLowerCase();
      if (["button","checkbox","color","file","hidden","image","radio","range","reset","submit"].indexOf(type) !== -1) return false;
      if (type === "password") return "password";
      if (type === "email" || type === "tel" || type === "url" || type === "search") return type;
      if (type === "number") return "decimal";
      return "text";
    })()`;

  /** A page that focuses its field a beat after the click (a search box that opens first). */
  const FOCUS_RECHECK_MS = 250;

  const PHONE_FIELDS: ReadonlySet<string> = new Set([
    "text",
    "email",
    "numeric",
    "decimal",
    "tel",
    "url",
    "search",
    "password",
  ]);

  const probeFocus = (page: BrowserPage) =>
    Effect.tryPromise({
      try: () => page.evaluate(FOCUS_PROBE),
      catch: (cause) => classifyPageError(cause),
    }).pipe(Effect.option);

  /** The newest focus-moving input each viewer sent: an older input's late look is dropped. */
  const focusInputs = new WeakMap<ViewerHandle, number>();

  const offerFocus = (viewer: ViewerHandle, probed: unknown, seq: number | undefined) => {
    const field = typeof probed === "string" && PHONE_FIELDS.has(probed) ? probed : undefined;
    const editable = field !== undefined || probed === true;
    return Queue.offer(
      viewer.outbox,
      JSON.stringify({
        _tag: "FocusChanged",
        editable,
        ...(field === undefined ? {} : { field }),
        ...(seq === undefined ? {} : { seq }),
      }),
    ).pipe(Effect.asVoid);
  };

  /**
   * Tell the tapping viewer whether its keyboard should stay up, and which
   * one. A probe that fails says nothing: leaving an already-raised keyboard
   * alone is far less disruptive than yanking it down on a guess. "No field"
   * is only said after a second look, off the input path, so a page that
   * focuses its field a beat late keeps the keyboard the tap raised.
   */
  const reportFocus = (viewer: ViewerHandle, page: BrowserPage, seq: number | undefined) =>
    Effect.gen(function* () {
      const mine = (focusInputs.get(viewer) ?? 0) + 1;
      focusInputs.set(viewer, mine);
      const probed = yield* probeFocus(page);
      if (Option.isNone(probed)) return;
      if (probed.value !== false) return yield* offerFocus(viewer, probed.value, seq);
      runFork(
        Effect.gen(function* () {
          yield* Effect.sleep(FOCUS_RECHECK_MS);
          if (page.isClosed() || page.pendingDialog() !== null) return;
          // A newer tap or key has taken over; its own look speaks for focus now.
          if (focusInputs.get(viewer) !== mine) return;
          const again = yield* probeFocus(page);
          if (Option.isSome(again)) yield* offerFocus(viewer, again.value, seq);
        }),
      );
    });

  /** The last scroll step sent to Chrome, so a pointer input right after it can wait for it to land. */
  let lastWheel: {
    readonly page: BrowserPage;
    readonly at: number;
    readonly x: number;
    readonly y: number;
  } | null = null;

  const dispatchHumanInput = async (
    page: BrowserPage,
    message: PersonalBrowserInputMessage,
    telemetry: ViewerTelemetry | null,
  ) => {
    switch (message._tag) {
      case "Pointer":
        if (message.action === "tap") {
          const clickedAt = performance.now();
          await page.mouseClick(message.x, message.y);
          telemetry?.cdp("click", performance.now() - clickedAt);
          return;
        }
        await page.mouseMove(message.x, message.y);
        if (message.action === "down") await page.mouseDown();
        if (message.action === "up") await page.mouseUp();
        return;
      case "Wheel": {
        // A run of scroll steps is motion: the picture goes rough until it stops.
        motion?.wheel();
        if (options.wheelFold !== false) {
          const foldedAt = performance.now();
          const folded = await page
            .mouseWheelAt(message.x, message.y, message.deltaX, message.deltaY)
            .then(
              () => true,
              () => false,
            );
          if (folded) {
            telemetry?.cdp("wheel", performance.now() - foldedAt);
            lastWheel = { page, at: performance.now(), x: message.x, y: message.y };
            return;
          }
          // The one-call form was refused: fall back to a move and a wheel.
        }
        const movedAt = performance.now();
        await page.mouseMove(message.x, message.y);
        const wheeledAt = performance.now();
        await page.mouseWheel(message.deltaX, message.deltaY);
        telemetry?.cdp("move", wheeledAt - movedAt);
        telemetry?.cdp("wheel", performance.now() - wheeledAt);
        lastWheel = { page, at: performance.now(), x: message.x, y: message.y };
        return;
      }
      case "Key":
        return page.keyPress([...(message.modifiers ?? []), message.key].join("+"));
      case "InsertText":
        return page.insertText(message.text);
      case "Navigate": {
        const resolved = resolveBrowserUrl(message.url);
        if (!resolved.ok)
          throw new HostOperationError("PreviewAutomationExecutionError", resolved.reason);
        return gotoReplacing(page, resolved.url, { waitUntil: "commit", timeoutMs: 15_000 });
      }
      case "Back":
        return page.goBack();
      case "Forward":
        return page.goForward();
      case "Reload":
        return page.reload();
      case "Viewport":
        // Handled by syncHumanViewport before dispatch; never a page action.
        return;
      case "ScrollEnd":
        // Handled before dispatch too: it only tells the picture quality controller.
        return;
      case "AnswerDialog":
        // Handled before dispatch too: it is the one input a dialog allows.
        return;
    }
  };

  /**
   * Settles with `run`, or as soon as a dialog opens on the page: the tap
   * that opened it would otherwise wait until someone answers it, and the
   * panel only learns to draw the dialog once the input has settled.
   */
  const untilDialog = <A>(page: BrowserPage, run: () => Promise<A>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const unsubscribe = page.onDialogChange((dialog) => {
        if (dialog === null) return;
        unsubscribe();
        resolve();
      });
      run().then(
        () => {
          unsubscribe();
          resolve();
        },
        (cause: unknown) => {
          unsubscribe();
          reject(cause);
        },
      );
    });

  /** Phone-reported stats are logged at most once a second per viewer. */
  const phoneStatsLoggedAt = new WeakMap<ViewerHandle, number>();

  const handleViewerInput = (
    viewer: ViewerHandle,
    raw: string,
    noteKind: (kind: StreamInputKind) => void,
  ) =>
    Effect.gen(function* () {
      const decoded = yield* decodeInputMessage(raw).pipe(Effect.option);
      if (Option.isNone(decoded)) return yield* rejectInput(viewer, "Malformed input message.");
      const message = decoded.value;
      // Pacing, not input: any viewer's acknowledgement counts, whoever holds control.
      if (message._tag === "FrameAck") return viewer.flow.acknowledge();
      // Timings the phone measured: logged next to the server's own, never acted on.
      if (message._tag === "StreamStats") {
        const at = performance.now();
        if (viewer.telemetry !== null && at - (phoneStatsLoggedAt.get(viewer) ?? -1_000) >= 1_000) {
          phoneStatsLoggedAt.set(viewer, at);
          const { _tag: _ignored, ...stats } = message;
          viewer.telemetry.phone(stats);
        }
        return;
      }
      noteKind(streamInputKind(message));
      // A viewport request is the client's own housekeeping, not something
      // the user did, so refusing it (a race with Return to bot) is silent.
      // The same goes for a finger lifting after control moved away.
      const refuse = (reason: string) =>
        message._tag === "Viewport" || message._tag === "ScrollEnd"
          ? Effect.void
          : rejectInput(viewer, reason);
      if (!viewer.canOperate) {
        return yield* refuse("This session is read-only and cannot control the browser.");
      }
      if (!(yield* lease.isHumanController(viewer.sessionId))) {
        return yield* refuse("Take control before interacting with the browser.");
      }
      if (message._tag === "Viewport") {
        st.humanViewport = {
          sessionId: viewer.sessionId,
          viewerId: viewer.id,
          size: clampPersonalBrowserViewport(message),
        };
        return yield* syncHumanViewport;
      }
      if (message._tag === "ScrollEnd") {
        // Hint only: no page is touched. The picture goes sharp once the last step has landed.
        motion?.end();
        return;
      }
      const page = runtime.phase === "connected" ? viewportPage() : null;
      if (page === null) return yield* rejectInput(viewer, "The browser has no open page yet.");
      if (message._tag === "AnswerDialog") {
        const answered = yield* Effect.promise(() =>
          page.answerDialog(message.accept, message.promptText),
        );
        yield* notify;
        if (!answered) yield* rejectInput(viewer, "That dialog has already closed.");
        return;
      }
      if (page.pendingDialog() !== null) {
        // Every page input waits on the dialog, so it has to be answered first.
        return yield* rejectInput(viewer, "Answer the page's dialog first.");
      }
      // A tap straight after a scroll must hit the page the scroll left, not the one before it.
      if (
        message._tag === "Pointer" &&
        options.scrollSettle !== false &&
        lastWheel !== null &&
        lastWheel.page === page &&
        performance.now() - lastWheel.at <= SCROLL_SETTLE_WINDOW_MS
      ) {
        const { x, y } = lastWheel;
        lastWheel = null;
        const settleStartedAt = performance.now();
        const settled = yield* Effect.tryPromise(() =>
          page.evaluate(scrollSettleExpression(x, y)),
        ).pipe(
          Effect.timeoutOption(SCROLL_SETTLE_CAP_MS + 150),
          Effect.map((result) => (Option.isSome(result) ? result.value : -1)),
          Effect.orElseSucceed(() => -1),
        );
        const outcome = settleOutcome(settled, performance.now() - settleStartedAt);
        viewer.telemetry?.scrollSettle(outcome.waitedMs, outcome.capped);
      }
      const exit = yield* Effect.exit(
        Effect.tryPromise({
          try: () => untilDialog(page, () => dispatchHumanInput(page, message, viewer.telemetry)),
          catch: (cause) => classifyPageError(cause),
        }),
      );
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        yield* rejectInput(viewer, error instanceof Error ? error.message : "Input failed.");
        return;
      }
      // A tap is what the phone raises its own keyboard for; Tab and Enter
      // move focus on (the next field, or off the form it submitted).
      if (personalBrowserInputMovesFocus(message)) {
        if (page.pendingDialog() !== null) return yield* notify;
        const seq = message._tag === "Pointer" || message._tag === "Key" ? message.seq : undefined;
        yield* reportFocus(viewer, page, seq);
      }
    });

  const handleViewerMessage: PersonalBrowser["Service"]["handleViewerMessage"] = (
    viewer,
    raw,
    arrivedAt,
  ) => {
    const telemetry = viewer.telemetry;
    if (telemetry === null) return handleViewerInput(viewer, raw, () => undefined);
    return Effect.gen(function* () {
      const startedAt = performance.now();
      const rejectedBefore = rejections.get(viewer) ?? 0;
      let kind: StreamInputKind | null = null;
      yield* handleViewerInput(viewer, raw, (noted) => {
        kind = noted;
      });
      // Acknowledgements and phone stats are not input; they are not timed.
      if (kind === null) return;
      telemetry.inputHandled({
        kind,
        arrivedAt: arrivedAt ?? startedAt,
        waitMs: arrivedAt === undefined ? 0 : Math.max(0, startedAt - arrivedAt),
        handleMs: performance.now() - startedAt,
        failed: (rejections.get(viewer) ?? 0) > rejectedBefore,
      });
    });
  };

  return { attachViewer, handleViewerMessage };
};

export type BrowserViewers = ReturnType<typeof makeBrowserViewers>;
