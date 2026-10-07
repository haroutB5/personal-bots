// @effect-diagnostics nodeBuiltinImport:off - the Chrome profile-lock probe needs readlink and open flags, and the artifact scan must skip symlinks.
/**
 * The server-owned persistent Chrome that bots and the user share.
 *
 * Chrome launches lazily (first agent op or Take control) on a dedicated
 * profile under `<baseDir>/personal/browser-profiles/default`, never the
 * user's everyday profile, and the profile is never deleted: a locked profile
 * is reported as `locked`. Agent tabs are opened through PreviewManager so tab
 * ids and preview events match the rest of the app. The live viewport is a CDP
 * screencast that runs only while at least one viewer socket is attached.
 */
import {
  PersonalBrowserError,
  ThreadId,
  type PersonalBotId,
  type PersonalBrowserFilesResult,
  type PersonalBrowserHelpRequest,
  type PersonalBrowserStatus,
  type PersonalBrowserStreamItem,
  type PersonalTaskId,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { type BrowserDriver, makePlaywrightDriver } from "./driver.ts";
import { HostOperationError, type PersonalLoginFilledField } from "./pageOperations.ts";
import { resolveBrowserUrl } from "./urlPolicy.ts";
import { STREAM_TELEMETRY_FLUSH_MS } from "./streamTelemetry.ts";
import {
  RESTORE_NAVIGATE_TIMEOUT_MS,
  type ResolvedBrowserFile,
  type ViewerHandle,
  encodeStreamLine,
} from "./browserShared.ts";
import { makeBrowserControl } from "./browserControl.ts";
import { makeBrowserCore } from "./browserCore.ts";
import { makeBrowserLaunch } from "./browserLaunch.ts";
import { makeBrowserLifecycle } from "./browserLifecycle.ts";
import { makeBrowserOperations } from "./browserOperations.ts";
import { makeBrowserTabs } from "./browserTabs.ts";
import { makeBrowserViewers } from "./browserViewers.ts";

export {
  CONTROL_GRACE_MS,
  HOST_REPLY_MARGIN_MS,
  driverTimeoutFor,
  dialogOpenError,
  looksLikeLoginPage,
  type ResolvedBrowserFile,
  type ViewerHandle,
} from "./browserShared.ts";

export class PersonalBrowser extends Context.Service<
  PersonalBrowser,
  {
    readonly status: (sessionId: string) => Effect.Effect<PersonalBrowserStatus>;
    readonly takeControl: (sessionId: string) => Effect.Effect<PersonalBrowserStatus>;
    readonly returnToAgent: (sessionId: string) => Effect.Effect<PersonalBrowserStatus>;
    /** Parks the caller's task and exposes why the user needs to take over. */
    readonly requestHelp: (input: {
      readonly threadId: ThreadId;
      readonly botId: PersonalBotId;
      readonly botName: string;
      readonly taskId: PersonalTaskId;
      readonly reason: string;
    }) => Effect.Effect<PersonalBrowserHelpRequest, HostOperationError>;
    /**
     * Ends the shared browser session outright: every tab closed, Chrome
     * stopped, the lease released whoever held it, and the saved page dropped
     * so the next boot does not reopen what was just closed. Idempotent — a
     * second close on an already-offline browser changes nothing and records
     * no activity. `byThreadId` names the bot that asked; null means the user.
     * A bot's close is refused, inside the lease lock, while a human holds
     * control: checking that from the caller leaves a window in which the
     * takeover lands after the check and before the teardown.
     */
    readonly closeBrowser: (input: {
      readonly sessionId: string;
      readonly byThreadId: ThreadId | null;
    }) => Effect.Effect<PersonalBrowserStatus, HostOperationError>;
    readonly listFiles: Effect.Effect<PersonalBrowserFilesResult, PersonalBrowserError>;
    readonly resolveFile: (
      fileId: string,
    ) => Effect.Effect<Option.Option<ResolvedBrowserFile>, PersonalBrowserError>;
    /**
     * Gives up everything the browser holds for one thread: its open tabs, and
     * the shared lease when that thread owns it. Called when the thread is
     * deleted, so a removed chat cannot keep a tab open, keep reading as the
     * browser's controller, or have its page reopened by a later restart.
     */
    readonly releaseThread: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * The user-marked sensitive origins this thread, and the delegation tree
     * it works in, has had open — sorted. Read by the egress channels the
     * browser guard cannot see (the research tools), so they can refuse while
     * the thread is carrying sensitive-site content. Empty means nothing
     * sensitive has been opened, not that the thread is trusted.
     */
    readonly sensitiveExposure: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<string>>;
    readonly activity: (sessionId: string) => Stream.Stream<PersonalBrowserStreamItem>;
    readonly handleAutomationRequest: (
      request: PreviewAutomationRequest,
    ) => Effect.Effect<unknown, HostOperationError>;
    readonly fillLogin: (input: {
      readonly threadId: ThreadId;
      /** User-facing login name, for the activity line only. Never a credential. */
      readonly label: string;
      readonly expectedOrigin: string;
      readonly username: string;
      readonly password: string;
      /** A login card is bound to the requesting tab's origin generation. */
      readonly expectedTabId?: string;
    }) => Effect.Effect<ReadonlyArray<PersonalLoginFilledField>, HostOperationError>;
    /** Server-only binding, with no page text, credential or signed URL. */
    readonly loginPage: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly tabId: string; readonly origin: string } | null>;
    readonly attachViewer: (input: {
      readonly sessionId: string;
      readonly canOperate: boolean;
    }) => Effect.Effect<ViewerHandle, never, Scope.Scope>;
    /** `arrivedAt` (performance.now) is when the socket received it, for the queue-wait telemetry. */
    readonly handleViewerMessage: (
      viewer: ViewerHandle,
      raw: string,
      arrivedAt?: number,
    ) => Effect.Effect<void>;
  }
>()("t3/personal/browser/PersonalBrowser") {}

export interface PersonalBrowserOptions {
  readonly driver: BrowserDriver;
  readonly headless: boolean;
  readonly executablePath: string | undefined;
  /** Stream telemetry log lines (default on). */
  readonly streamTelemetry?: boolean;
  /** A phone scroll step is one Chrome call instead of a move and a wheel (default on). */
  readonly wheelFold?: boolean;
  /** A tap right after a phone scroll waits for the page to apply it (default on). */
  readonly scrollSettle?: boolean;
  /**
   * Chrome's ack for a frame goes as soon as the frame is written, overwritten by a newer one or
   * dropped (default on); off holds every frame's ack until the next write, as in 1.60.35.
   */
  readonly frameAckEarly?: boolean;
  /** A third unacknowledged frame while the link is not queueing (default on); off: always two. */
  readonly adaptiveAckWindow?: boolean;
  /** Frames per second one viewer is sent at most (default 30). */
  readonly streamMaxFps?: number | undefined;
  /**
   * A rougher, smaller picture while the page scrolls, a sharp one when it stops. Off from the
   * environment unless T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG=on (see docs/releases/HANDOFF-16044.md); on when
   * the option is left out, which is how the tests build it.
   */
  readonly adaptiveJpeg?: boolean;
  /** Quiet time after the last scroll step before the sharp picture comes back (ms; default 150). */
  readonly adaptiveSettleMs?: number | undefined;
  /**
   * How long a device that took control may stay disconnected before control goes back to the
   * agent (ms; default 60 000). 0 turns it off: control then stays until it is handed back.
   */
  readonly controlGraceMs?: number | undefined;
}

/**
 * Headed by default so the user can sign in on the laptop.
 * `T3CODE_PERSONAL_BROWSER_HEADLESS=1` runs headless;
 * `T3CODE_PERSONAL_BROWSER_EXECUTABLE` overrides the system Chrome channel.
 */
/** A frame rate from the environment, or undefined for the default. */
const streamMaxFpsFromEnvironment = (value: string | undefined): number | undefined => {
  const parsed = Number(value?.trim());
  return Number.isFinite(parsed) && parsed >= 5 && parsed <= 60 ? parsed : undefined;
};

/** A settle time in milliseconds from the environment, or undefined for the default. */
const adaptiveSettleMsFromEnvironment = (value: string | undefined): number | undefined => {
  const parsed = Number(value?.trim());
  return Number.isFinite(parsed) && parsed >= 30 && parsed <= 400 ? parsed : undefined;
};

/** A control grace period in milliseconds (0: never), or undefined for the default. */
const controlGraceMsFromEnvironment = (value: string | undefined): number | undefined => {
  const text = value?.trim().toLowerCase() ?? "";
  if (text === "off") return 0;
  const parsed = Number(text);
  return text !== "" && Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 3_600_000
    ? parsed
    : undefined;
};

export const optionsFromEnvironment = (): PersonalBrowserOptions => ({
  driver: makePlaywrightDriver(),
  headless: /^(1|true|yes)$/i.test(process.env.T3CODE_PERSONAL_BROWSER_HEADLESS ?? ""),
  executablePath: process.env.T3CODE_PERSONAL_BROWSER_EXECUTABLE?.trim() || undefined,
  // Kill switch: T3CODE_PERSONAL_BROWSER_STREAM_TELEMETRY=off stops the stream log lines.
  streamTelemetry: process.env.T3CODE_PERSONAL_BROWSER_STREAM_TELEMETRY?.trim() !== "off",
  // Kill switch: T3CODE_PERSONAL_BROWSER_WHEEL_FOLD=off sends the move and the wheel separately again.
  wheelFold: process.env.T3CODE_PERSONAL_BROWSER_WHEEL_FOLD?.trim() !== "off",
  // Kill switch: T3CODE_PERSONAL_BROWSER_SCROLL_SETTLE=off dispatches a tap at once after a scroll again.
  scrollSettle: process.env.T3CODE_PERSONAL_BROWSER_SCROLL_SETTLE?.trim() !== "off",
  // Kill switches: T3CODE_PERSONAL_BROWSER_FRAME_ACK_EARLY=off holds Chrome's ack for every frame until the next
  // write again; T3CODE_PERSONAL_BROWSER_STREAM_MAX_FPS=20 restores the old frame rate cap.
  frameAckEarly: process.env.T3CODE_PERSONAL_BROWSER_FRAME_ACK_EARLY?.trim() !== "off",
  // Kill switch: T3CODE_PERSONAL_BROWSER_ADAPTIVE_ACK_WINDOW=off keeps the window at two frames.
  adaptiveAckWindow: process.env.T3CODE_PERSONAL_BROWSER_ADAPTIVE_ACK_WINDOW?.trim() !== "off",
  streamMaxFps: streamMaxFpsFromEnvironment(process.env.T3CODE_PERSONAL_BROWSER_STREAM_MAX_FPS),
  // Opt-in: T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG=on. Without it one picture quality is streamed, as in 1.60.42.
  adaptiveJpeg: /^(on|1|true|yes)$/i.test(
    process.env.T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG?.trim() ?? "",
  ),
  // T3CODE_PERSONAL_BROWSER_CONTROL_GRACE_MS=off keeps control with a disconnected device until it is handed back (1.60.44 behaviour).
  controlGraceMs: controlGraceMsFromEnvironment(
    process.env.T3CODE_PERSONAL_BROWSER_CONTROL_GRACE_MS,
  ),
  adaptiveSettleMs: adaptiveSettleMsFromEnvironment(
    process.env.T3CODE_PERSONAL_BROWSER_ADAPTIVE_SETTLE_MS,
  ),
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = (rawOptions: PersonalBrowserOptions) =>
  Effect.gen(function* () {
    const core = yield* makeBrowserCore(rawOptions);
    const { lease, options, sensitiveExposure, status, viewers } = core;

    const launch = yield* makeBrowserLaunch(core);

    const tabs = makeBrowserTabs(core, launch);
    const { createTab, releaseThread, setActive, syncPreviewStatus } = tabs;

    const operations = makeBrowserOperations(core, launch, tabs);
    const { handleAutomationRequest, navigateTab } = operations;

    const control = yield* makeBrowserControl(core, launch, tabs, operations);
    const { fillLogin, loginPage, requestHelp, returnToAgent, takeControl } = control;

    const lifecycle = yield* makeBrowserLifecycle(core, launch, tabs);
    const { activity, closeBrowser, listFiles, resolveFile } = lifecycle;

    const viewerPart = makeBrowserViewers(core, launch, operations);
    const { attachViewer, handleViewerMessage } = viewerPart;

    /**
     * Reopens the page the agent had open before the restart so the phone keeps
     * showing "<bot> is using the browser" with the right Back-to-chat target.
     * Runs once in the background at boot: it never blocks startup, never
     * throws, and never retries — a failed restore releases the lease to a
     * clean None while the browser keeps whatever offline/locked state the
     * launch reported. With no saved page there is nothing to reopen, so the
     * browser stays lazily offline and the (already restored) lease simply
     * applies to the next op.
     */
    const restoreAfterRestart = Effect.gen(function* () {
      const restored = yield* lease.view;
      if (restored.ownerType !== "agent" || restored.ownerId === null) return;
      if (restored.lastUrl === null) return;
      const target = resolveBrowserUrl(restored.lastUrl);
      if (!target.ok) return;
      const threadId = ThreadId.make(restored.ownerId);
      // Serialized like any other agent op: an op racing boot either runs
      // first (and the restore then reuses its tab) or waits behind the
      // restore, so the two can never open competing tabs.
      yield* lease.runAgentOp(
        { threadId: restored.ownerId, operation: "navigate" },
        Effect.gen(function* () {
          const tab = yield* createTab(threadId, target.url);
          yield* navigateTab(tab, target.url, "load", RESTORE_NAVIGATE_TIMEOUT_MS);
          yield* setActive(tab);
          yield* syncPreviewStatus(tab);
        }),
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            "Personal browser session could not be restored after restart.",
            {
              cause,
            },
          );
          yield* lease.releaseAgentLease;
        }),
      ),
    );

    yield* restoreAfterRestart.pipe(Effect.forkScoped);

    // One log line per attached viewer every few seconds; nothing while nobody watches.
    if (options.streamTelemetry !== false) {
      yield* Effect.forever(
        Effect.sleep(STREAM_TELEMETRY_FLUSH_MS).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              // A copy: viewers attach and leave while a line is being written.
              // oxlint-disable-next-line unicorn/no-useless-spread
              for (const viewer of [...viewers.values()]) {
                if (viewer.telemetry === null) continue;
                const control = yield* lease.isHumanController(viewer.sessionId);
                const line = viewer.telemetry.flush({ control, window: viewer.flow.windowSize });
                if (line !== null) {
                  yield* Effect.logInfo(`browser-stream ${encodeStreamLine(line)}`);
                }
              }
            }),
          ),
        ),
      ).pipe(Effect.forkScoped);
    }

    return PersonalBrowser.of({
      status,
      takeControl,
      requestHelp,
      returnToAgent,
      closeBrowser,
      listFiles,
      resolveFile,
      releaseThread,
      sensitiveExposure,
      activity,
      handleAutomationRequest,
      fillLogin,
      loginPage,
      attachViewer,
      handleViewerMessage,
    });
  });

export const makeLayer = (options: PersonalBrowserOptions) =>
  Layer.effect(PersonalBrowser, make(options));

export const layer = Layer.unwrap(Effect.sync(() => makeLayer(optionsFromEnvironment())));
