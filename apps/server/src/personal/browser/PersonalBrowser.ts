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
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  clampPersonalBrowserViewport,
  encodePersonalBrowserFrame,
  PERSONAL_TASK_TERMINAL_STATUSES,
  PersonalBrowserError,
  personalBrowserInputMovesFocus,
  PersonalBrowserInputMessage,
  PersonalBrowserViewerMessage,
  PersonalTaskStatus,
  ThreadId,
  type PersonalBotId,
  type PersonalBrowserActivityEvent,
  type PersonalBrowserActivityKind,
  type PersonalBrowserController,
  type PersonalBrowserFile,
  type PersonalBrowserFilesResult,
  type PersonalBrowserHelpRequest,
  type PersonalBrowserStatus,
  type PersonalBrowserStreamItem,
  type PersonalTaskId,
  type PreviewAutomationActionEvent,
  type PreviewAutomationClickInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResizeInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationWaitForInput,
  type PreviewTabId,
} from "@t3tools/contracts";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalLoginRepository from "../secrets/PersonalLoginRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import { AGENT_LEASE_TTL_MS, BrowserLease, PERSONAL_BROWSER_PROFILE_ID } from "./BrowserLease.ts";
import { applyRequestedProfileReset } from "./browserProfileReset.ts";
import { makeCredentialRedactor } from "./credentialRedactor.ts";
import { type EgressApproval, type EgressIntent, egressNeedingApproval } from "./egressGuard.ts";
import {
  LOGIN_SCRIPT_REFUSED,
  guardedExpression,
  loginCookieScopes,
  loginOriginCovering,
} from "./loginOrigins.ts";
import {
  makeSensitiveExposureStore,
  rootExposureKey,
  type SensitiveExposureKind,
  threadExposureKey,
} from "./sensitiveExposureStore.ts";
import {
  type BrowserContextHandle,
  type BrowserDriver,
  type BrowserPage,
  makePlaywrightDriver,
  type PageDialog,
  type ScreencastMeta,
  type ViewportOverride,
  type ViewportSize,
} from "./driver.ts";
import { createMotionController } from "./adaptiveJpeg.ts";
import {
  captureSnapshot,
  BOT_CHECK_PROBE,
  classifyBotCheck,
  classifyPageError,
  HostOperationError,
  isReplacedNavigation,
  performClick,
  performEvaluate,
  performFillLogin,
  performPress,
  performScroll,
  performType,
  performWaitFor,
  type PersonalLoginFilledField,
} from "./pageOperations.ts";
import {
  type BrowserProtectionState,
  PersonalBrowserProtectionRepository,
} from "./PersonalBrowserProtectionRepository.ts";
import { resolveBrowserNavigationTarget, resolveBrowserUrl } from "./urlPolicy.ts";
import {
  SCROLL_SETTLE_CAP_MS,
  SCROLL_SETTLE_WINDOW_MS,
  scrollSettleExpression,
  settleOutcome,
} from "./scrollSettle.ts";
import {
  STREAM_TELEMETRY_FLUSH_MS,
  type StreamInputKind,
  ViewerTelemetry,
} from "./streamTelemetry.ts";
import {
  offerFrameToFlows,
  untilAnyFlowTookFrame,
  VIEWER_FLOW_LIMITS,
  ViewerFlow,
} from "./viewerFlow.ts";

/** Chrome did not start; `message` is Playwright's own error text. */
class PersonalBrowserLaunchError extends Data.TaggedError("PersonalBrowserLaunchError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface ViewerHandle {
  readonly id: number;
  readonly sessionId: string;
  readonly canOperate: boolean;
  /**
   * Control messages (rejections, focus, hidden notices). Unbounded so none is
   * ever dropped; they are rare and tiny, and a closed socket shuts it down.
   */
  readonly outbox: Queue.Queue<string>;
  /** Frames: only the newest unsent one is kept, and it is released at the link's pace. */
  readonly flow: ViewerFlow;
  /** What this viewer's stream measures about itself; null when the telemetry is switched off. */
  readonly telemetry: ViewerTelemetry | null;
  /** The sharp picture follows a lifted finger at once, so the client is asked to say when it lifts. */
  readonly scrollEndHint?: boolean;
}

export interface ResolvedBrowserFile {
  readonly path: string;
  readonly name: string;
}

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
   * environment unless T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG=on (see HANDOFF-16044); on when
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

type Phase = "offline" | "starting" | "connected" | "crashed" | "locked";

interface TabEntry {
  readonly tabId: PreviewTabId;
  readonly threadId: ThreadId;
  readonly page: BrowserPage;
  title: string;
  readonly timeline: PreviewAutomationActionEvent[];
  /** Model-readable operations are disabled while a credential is in this document. */
  loginProtected: boolean;
  /** The URL a saved login was filled on; null once the tab has left that form. */
  credentialFormUrl: string | null;
  /**
   * A model-provided script has run in this tab since the last server-initiated
   * navigation. Such a tab is never a fill target: `preview_evaluate` can leave
   * an input listener behind that reads a value the tool result never returns.
   */
  scriptTainted: boolean;
  /** The answer `preview_type` gave the open prompt dialog, sent with Enter. */
  dialogPromptText: string | null;
  loginOriginRevision: number;
}

const RECENT_ACTIVITY_LIMIT = 30;
/**
 * A headed Chrome nobody is using costs 300-600 MB and a compositor, and
 * nothing ever closed it: the only shutdown paths were an explicit close, a
 * thread release and a crash, so one page a bot opened and forgot sat there
 * until someone noticed. After this long with no sign of use it closes itself,
 * and the next browser action or Take control starts it again exactly as
 * before. Checked once a tick, and any sign of use resets the count, so the
 * browser has to be idle for the whole stretch, not merely at the moment the
 * sweep happens to look.
 */
/** A device that took control and then disconnected keeps it this long (see PersonalBrowserOptions.controlGraceMs). */
export const CONTROL_GRACE_MS = 60_000;
/** How often the disconnected-controller check runs. */
const CONTROL_CHECK_INTERVAL_MS = 5_000;
const IDLE_CLOSE_AFTER_TICKS = 10;
const IDLE_CHECK_INTERVAL_MS = 60_000;
const IDLE_CLOSE_SUMMARY = "Browser closed after 10 minutes with nobody using it";
/** Statuses a task can still leave on its own; its thread may need the browser. */
const LIVE_TASK_STATUSES = PersonalTaskStatus.literals.filter(
  (status) => !PERSONAL_TASK_TERMINAL_STATUSES.includes(status),
);
const RESTORE_NAVIGATE_TIMEOUT_MS = 30_000;
/** The server's own navigation of the fresh tab a saved login is filled into. */
const FILL_NAVIGATE_TIMEOUT_MS = 20_000;
const TIMELINE_LIMIT = 20;
/**
 * The broker treats a request it has not heard back on within its timeout as
 * a dead host and evicts it, which fails every bot's next call until the host
 * re-registers. So the host always answers first: a whole request (lease wait
 * and Chrome start included) finishes this long before the broker's deadline,
 * and driver calls get a further margin so their own, more specific, timeout
 * message is what the bot sees.
 */
export const HOST_REPLY_MARGIN_MS = 750;
const DRIVER_TIMEOUT_MARGIN_MS = 1_500;
const MIN_DRIVER_TIMEOUT_MS = 250;
/** How long `unstick` waits for a page to answer before stopping its script. */
const UNSTICK_PROBE_MS = 1_000;

/** The driver's budget within a request's broker timeout. */
export const driverTimeoutFor = (requestTimeoutMs: number, inputTimeoutMs?: number) =>
  Math.max(
    MIN_DRIVER_TIMEOUT_MS,
    Math.min(inputTimeoutMs ?? requestTimeoutMs, requestTimeoutMs) - DRIVER_TIMEOUT_MARGIN_MS,
  );

const describeDialog = (dialog: PageDialog) => {
  const text = dialog.message.replace(/\s+/g, " ").trim().slice(0, 300);
  switch (dialog.type) {
    case "beforeunload":
      return "The page opened a leave-page dialog (it asks to confirm leaving)";
    case "alert":
      return `The page opened an alert dialog: '${text}'`;
    default:
      return `The page opened a ${dialog.type} dialog: '${text}'`;
  }
};

/**
 * What a bot is told when a native dialog is (or becomes) open on its tab.
 * The dialog is left open on purpose: a destructive confirm is Harout's call.
 */
export const dialogOpenError = (dialog: PageDialog) =>
  new HostOperationError(
    "PreviewAutomationExecutionError",
    `${describeDialog(dialog)}. It is still open and the page is paused until it is answered. ` +
      "Hand over to Harout with request_browser_help, or answer it with preview_press: " +
      `key 'Enter' for OK or 'Escape' for Cancel${
        dialog.type === "prompt" ? " (preview_type first sets the prompt's answer)" : ""
      }.`,
    { dialog },
  );
const PAGE_INFO_REFRESH_MS = 1_500;
const MAX_LISTED_FILES = 300;
/** A 390px phone gets 780px frames: exactly the screencast's maxWidth, so crisp and uncapped. */
const PHONE_DEVICE_SCALE_FACTOR = 2;
const ARTIFACT_SCAN_DEPTH = 3;

// Continuations for a help request that ended without Return to bot. The bot's
// task is parked on waiting_for_browser, and only a resume brings it back.
const HELP_ENDED_BY_CLOSE =
  "The shared browser was closed before the user finished helping, so your browser help request was cancelled. Tell the user in one sentence what you still need. Reopen the page only if the task still needs it, and call request_browser_help again if you get blocked.";
const HELP_ENDED_BY_CRASH =
  "Chrome exited before the user finished helping, so your browser help request was cancelled. Reopen the page and call request_browser_help again if you are still blocked, or tell the user in one sentence what you still need.";
const HELP_ENDED_BY_SWITCH =
  "Another chat started using the shared browser before the user finished helping, so your browser help request was cancelled. Tell the user in one sentence what you still need, or call request_browser_help again once you have the browser back.";

const decodeInputMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersonalBrowserInputMessage),
);
const encodeViewerMessage = Schema.encodeSync(Schema.fromJsonString(PersonalBrowserViewerMessage));
const encodeStreamLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Only the kind of input is ever recorded, never what it did or where. */
const streamInputKind = (message: PersonalBrowserInputMessage): StreamInputKind => {
  switch (message._tag) {
    case "Pointer":
      return message.action === "tap" ? "tap" : "other";
    case "Wheel":
      return "wheel";
    case "Key":
    case "InsertText":
      return "key";
    default:
      return "other";
  }
};

const FRAMES_HIDDEN_REASON =
  "Hidden while a bot fills a saved password. The view returns when the page moves on, or when you take control.";

const firstLine = (value: string) => value.split("\n")[0]?.trim() || "Unknown error";

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** Real URL-derived signal only: known identity-provider hosts and sign-in paths. */
export const looksLikeLoginPage = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      /^(accounts|login|signin|auth|sso|id)\./i.test(parsed.hostname) ||
      /\/(login|log-in|signin|sign-in|sign_in|oauth2?|authorize|sso)(\/|$|\?)/i.test(
        parsed.pathname,
      )
    );
  } catch {
    return false;
  }
};

async function detectProfileLock(
  profileDir: string,
): Promise<{ readonly locked: boolean; readonly pid: number | null }> {
  try {
    // POSIX Chrome: SingletonLock -> "<hostname>-<pid>".
    const target = await NodeFSP.readlink(NodePath.join(profileDir, "SingletonLock"));
    const pid = Number(/-(\d+)$/.exec(target)?.[1]);
    return { locked: true, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
  } catch {
    // fall through to the Windows lockfile probe
  }
  try {
    const handle = await NodeFSP.open(NodePath.join(profileDir, "lockfile"), "r+");
    await handle.close();
    return { locked: false, pid: null };
  } catch (cause) {
    const code = (cause as { readonly code?: string }).code;
    return code === "EBUSY" || code === "EPERM" || code === "EACCES"
      ? { locked: true, pid: null }
      : { locked: false, pid: null };
  }
}

interface ScannedFile extends PersonalBrowserFile {
  readonly path: string;
}

const fileKind = (relativePath: string): PersonalBrowserFile["kind"] => {
  if (/^downloads[\\/]/i.test(relativePath)) return "download";
  if (/\.(png|jpe?g|webp)$/i.test(relativePath)) return "screenshot";
  if (/\.(webm|mp4|mov)$/i.test(relativePath)) return "recording";
  return "other";
};

/** Ids are hashes of the relative path, so a client can never name a path directly. */
const fileIdFor = (relativePath: string) =>
  NodeCrypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 32);

async function scanArtifacts(root: string): Promise<ReadonlyArray<ScannedFile>> {
  const found: ScannedFile[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries: ReadonlyArray<import("node:fs").Dirent>;
    try {
      entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < ARTIFACT_SCAN_DEPTH) await walk(absolute, depth + 1);
        continue;
      }
      // Symlinks and special files are never listed or served.
      if (!entry.isFile()) continue;
      const stat = await NodeFSP.stat(absolute).catch(() => null);
      if (stat === null) continue;
      const relativePath = NodePath.relative(root, absolute);
      found.push({
        id: fileIdFor(relativePath),
        name: entry.name,
        kind: fileKind(relativePath),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        path: absolute,
      });
    }
  };
  await walk(root, 0);
  return found
    .toSorted((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    .slice(0, MAX_LISTED_FILES);
}

const sameStatus = (left: PersonalBrowserStatus, right: PersonalBrowserStatus) =>
  JSON.stringify(left) === JSON.stringify(right);

/** @public Service construction is part of the canonical Effect module API. */
export const make = (options: PersonalBrowserOptions) =>
  Effect.gen(function* () {
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
    let viewerSequence = 0;
    // Frames arrive on Playwright's callback, outside any effect, so the mask
    // reads a plain copy of who holds the browser. Every lease change refreshes
    // it; takeControl and returnToAgent also refresh it directly so the first
    // frame after either already sees the new owner.
    let humanInControl = (yield* lease.view).ownerType === "human";
    // Whether the device that holds control has had a viewer attached since it took it (a lease
    // restored at boot counts: the restart cut its viewer). A person who took control and never
    // opened a live view may be typing into the laptop's Chrome window, so only a device that was
    // watching and then went away loses control.
    let controlViewerSeen = humanInControl;
    let controlAbsentSince: number | null = null;
    // One FramesHidden notice per hidden stretch; a forwarded frame ends it.
    let framesHidden = false;
    let screencast: { readonly page: BrowserPage; readonly stop: () => Promise<void> } | null =
      null;
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
              const current = screencast;
              return current?.page.setScreencastProfile?.(profile) ?? Promise.resolve();
            },
            onChange: (profile) => {
              for (const viewer of viewers.values()) viewer.telemetry?.motion(profile === "moving");
            },
          });
    let lastPageInfoRefresh = 0;
    // The agent's own preview_resize per page, so a human's phone viewport is
    // undone back to exactly what the agent chose rather than to the window.
    const agentViewports = new WeakMap<BrowserPage, ViewportSize>();
    // What the controlling phone asked for, and where it is applied right now.
    let humanViewport: {
      readonly sessionId: string;
      readonly viewerId: number;
      readonly size: ViewportSize;
    } | null = null;
    let appliedViewport: { readonly page: BrowserPage; readonly size: ViewportSize } | null = null;

    const launchLock = yield* Semaphore.make(1);
    const screencastLock = yield* Semaphore.make(1);
    const viewportLock = yield* Semaphore.make(1);
    const statusDirty = yield* PubSub.unbounded<void>();
    const activityPubSub = yield* PubSub.unbounded<PersonalBrowserActivityEvent>();
    const recent: PersonalBrowserActivityEvent[] = [];
    let activeHelp: {
      readonly request: PersonalBrowserHelpRequest;
      readonly taskId: PersonalTaskId;
      /** Set when this request is the user's approval for a guarded destination. */
      readonly approval: EgressApproval | null;
    } | null = null;

    // Sensitive-site egress guard (policy in egressGuard.ts). What a bot has
    // had open is kept per thread and per delegation tree, since a delegated
    // brief can carry it. Persisted (sensitiveExposureStore.ts): the provider
    // session that saw the page is recovered with its resume cursor after a
    // restart, so a taint held in memory would be dropped while the model
    // still holds the page. It governs the shared browser and nothing else.
    const logins = yield* PersonalLoginRepository.PersonalLoginRepository;
    let sensitiveOrigins: ReadonlySet<string> = new Set();
    const exposureStore = makeSensitiveExposureStore(yield* SqlClient.SqlClient);
    // The approval a thread was refused for, until its next request_browser_help
    // turns it into the question the user actually sees.
    const pendingApprovals = new Map<string, EgressApproval>();

    const refreshSensitiveOrigins = logins.sensitiveOrigins().pipe(
      Effect.map((origins) => {
        sensitiveOrigins = new Set(origins);
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
        if (origin === null || !sensitiveOrigins.has(origin)) return;
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
          sensitive: sensitiveOrigins,
        });
        if (approval === null) return;
        pendingApprovals.set(threadId, approval);
        return yield* Effect.fail(
          new HostOperationError(
            "PreviewAutomationExecutionError",
            `Paused: this could carry what you saw on ${approval.sources.join(", ")} (a site the user marked sensitive) to ${approval.destination}. Call request_browser_help now with a one-line reason, tell the user in one sentence what you want to do, then end your turn. You continue automatically if they approve; do not try another route.`,
          ),
        );
      });

    const approvalQuestion = (approval: EgressApproval) =>
      `Allow sending what the bot saw on ${approval.sources.join(", ")} to ${approval.destination}? Take control, then Return to bot to allow. Close the browser to refuse.`;

    const notify = PubSub.publish(statusDirty, undefined).pipe(Effect.asVoid);

    /**
     * Ends a help request the user never finished and resumes the bot with
     * `note`. The task is parked on waiting_for_browser until something resumes
     * it, so every way a request can disappear other than Return to bot has to
     * come through here, or the task waits forever.
     */
    const abandonHelp = (note: string) =>
      Effect.gen(function* () {
        const pending = activeHelp;
        if (pending === null) return;
        activeHelp = null;
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
        const backThreadId: string | null = activeHelp?.request.threadId ?? view.lastAgentThreadId;
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
          helpRequest: activeHelp?.request ?? null,
          dialog: page === null ? null : redactor.redact(page.pendingDialog()),
          lastAgent,
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
      if (tab?.loginProtected === true && !humanInControl) {
        for (const viewer of viewers.values()) viewer.telemetry?.frameHidden();
        if (!framesHidden) {
          framesHidden = true;
          const notice = encodeViewerMessage({
            _tag: "FramesHidden",
            reason: FRAMES_HIDDEN_REASON,
          });
          for (const viewer of viewers.values()) Queue.offerUnsafe(viewer.outbox, notice);
        }
        // A frame still waiting for the link was taken before the form was filled.
        for (const viewer of viewers.values()) viewer.flow.dropPending();
      } else {
        framesHidden = false;
        const frame = encodePersonalBrowserFrame(jpeg, meta);
        handedOff = offerToViewers(frame);
      }
      // Frames only arrive when the page repaints, so they double as a cheap
      // trigger for noticing human navigation (url/title) without polling.
      const now = performance.now();
      if (now - lastPageInfoRefresh > PAGE_INFO_REFRESH_MS) {
        lastPageInfoRefresh = now;
        runFork(Effect.andThen(refreshPageInfo, notify));
      }
      return handedOff;
    };

    /** Screencast runs exactly while a viewer is attached to a live page. */
    const syncScreencast = screencastLock.withPermit(
      Effect.gen(function* () {
        const target = viewers.size > 0 && runtime.phase === "connected" ? viewportPage() : null;
        if (screencast !== null && (target === null || screencast.page !== target)) {
          const { stop } = screencast;
          screencast = null;
          motion?.reset();
          yield* Effect.promise(() => stop().catch(() => undefined));
        }
        if (target !== null) watchDialogs(target);
        if (target !== null && screencast === null) {
          const stop = yield* Effect.tryPromise(() =>
            target.startScreencast((jpeg, meta) => onFrame(target, jpeg, meta)),
          ).pipe(Effect.option);
          if (Option.isSome(stop)) screencast = { page: target, stop: stop.value };
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
            if (screencast === null || screencast.page !== page) return;
            const { stop } = screencast;
            screencast = null;
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
          humanViewport !== null &&
          view.ownerType === "human" &&
          view.ownerId === humanViewport.sessionId &&
          viewers.has(humanViewport.viewerId)
            ? humanViewport
            : null;
        humanViewport = held;
        const target = held !== null && runtime.phase === "connected" ? viewportPage() : null;
        const current = appliedViewport;
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
          appliedViewport = null;
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
          if (applied) appliedViewport = { page: target, size: held.size };
          yield* restartScreencastOn(target);
        }
      }),
    );

    const onContextClosed = (serial: number) =>
      Effect.gen(function* () {
        if (serial !== runtime.contextSerial) return;
        const tabs = [...runtime.tabs.values()];
        // One line per launch: counts only, never a URL.
        const adblock = runtime.context?.adblockStats?.();
        if (adblock?.enabled === true) {
          yield* Effect.logInfo("browser ad blocking summary", {
            rules: adblock.rules,
            requests: adblock.requests,
            blocked: adblock.blocked,
          });
        }
        runtime.context = null;
        runtime.tabs.clear();
        runtime.activeTabId = null;
        screencast = null;
        // Its page died with Chrome; a relaunch re-applies it if still wanted.
        appliedViewport = null;
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
      Effect.promise(async () => {
        runtime.closing = true;
        await runtime.context?.close().catch(() => undefined);
      }),
    );

    // Lease changes (takeover, return, agent switch) are status changes. A
    // human takeover keeps the request visible until control is returned; a
    // different agent taking the lease makes the old request stale.
    yield* lease.changes.pipe(
      Stream.runForEach((view) =>
        Effect.gen(function* () {
          humanInControl = view.ownerType === "human";
          if (
            activeHelp !== null &&
            view.ownerType === "agent" &&
            view.ownerId !== null &&
            view.ownerId !== activeHelp.request.threadId
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
      activeHelp !== null && activeHelp.request.threadId !== threadId
        ? abandonHelp(HELP_ENDED_BY_SWITCH)
        : Effect.void;

    const tabForRequest = (request: PreviewAutomationRequest): TabEntry | undefined => {
      if (request.tabId !== undefined) {
        const tab = runtime.tabs.get(request.tabId);
        if (tab !== undefined && tab.threadId === request.threadId && openPage(tab.page))
          return tab;
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
        yield* previewManager
          .close({ threadId: tab.threadId, tabId: tab.tabId })
          .pipe(Effect.ignore);
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
    const retireTabsInCookieScope = (input: {
      readonly origin: string;
      readonly except: TabEntry;
    }) =>
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
        if (activeHelp?.request.threadId === threadId) activeHelp = null;
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
              return yield* rejectUrl(
                "The dialog had already closed; take a snapshot to continue.",
              );
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
            const tab =
              tabForRequest(request) ?? (yield* createTab(request.threadId, resolved.url));
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
            if (
              tab.loginProtected &&
              (input.locator !== undefined || input.selector !== undefined)
            ) {
              return yield* rejectUrl(
                "Locator clicks are disabled after a saved login is filled. Use a button's coordinates captured before use_login, or press Enter.",
              );
            }
            yield* attempt(input, () =>
              performClick(tab.page, input, driverTimeoutFor(request.timeoutMs, input.timeoutMs)),
            );
            return { tab, result: { tabId: tab.tabId } };
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
              (/^(c|v|x)$/i.test(input.key) &&
                (modifiers.has("Control") || modifiers.has("Meta"))) ||
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
              return yield* rejectUrl(
                "Only Tab or Enter is allowed after a saved login is filled.",
              );
            }
            yield* attempt({}, () => performPress(tab.page, input));
            return { tab, result: { tabId: tab.tabId } };
          }
          case "scroll": {
            const input = request.input as PreviewAutomationScrollInput;
            if (
              tab.loginProtected &&
              (input.locator !== undefined || input.selector !== undefined)
            ) {
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
      Effect.promise(() =>
        page.unstick(UNSTICK_PROBE_MS).catch(() => "unresponsive" as const),
      ).pipe(
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
      request,
    ) => {
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
        humanInControl = true;
        controlViewerSeen = [...viewers.values()].some((viewer) => viewer.sessionId === sessionId);
        controlAbsentSince = null;
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
          if (activeHelp?.request.threadId === input.threadId) return activeHelp.request;
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
          activeHelp = { request, taskId: input.taskId, approval };
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
        humanInControl = (yield* lease.view).ownerType === "human";
        controlViewerSeen = false;
        controlAbsentSince = null;
        // The agent gets its own viewport back before it can run another op.
        yield* syncHumanViewport;
        if (before.ownerType === "human") {
          const finishedHelp = activeHelp;
          activeHelp = null;
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
        controlAbsentSince = null;
        return;
      }
      const owner = view.ownerId;
      if ([...viewers.values()].some((viewer) => viewer.sessionId === owner)) {
        controlViewerSeen = true;
        controlAbsentSince = null;
        return;
      }
      if (!controlViewerSeen || activeHelp !== null) {
        controlAbsentSince = null;
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      controlAbsentSince ??= now;
      if (now - controlAbsentSince < controlGraceMs) return;
      yield* Effect.logInfo(
        "returning browser control to the agent: the device that had it disconnected",
        {
          seconds: Math.round((now - controlAbsentSince) / 1_000),
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

    /**
     * Gives up everything the browser holds and leaves it `offline`: every tab
     * closed, Chrome stopped, the lease released, the saved page dropped and
     * one activity line recorded. Idempotent, and the only teardown there is —
     * the user's Close, a bot's close and the idle sweep all land here, so the
     * phone's panel retires the same way whichever one fired.
     *
     * The caller holds the lease lock; this takes the launch lock so a close
     * can never interleave with a launch and leave a live context behind an
     * "offline" phase.
     */
    const teardownBrowser = (input: {
      readonly sessionId: string;
      readonly byThreadId: ThreadId | null;
      readonly reason: "explicit" | "idle";
    }) =>
      launchLock.withPermit(
        Effect.gen(function* () {
          const leaseBefore = yield* lease.view;
          // "Nothing to close" is the whole idempotency test: no Chrome, no
          // controller and no saved page means a second close is a no-op.
          const closedSomething =
            runtime.phase !== "offline" ||
            leaseBefore.ownerId !== null ||
            leaseBefore.lastUrl !== null;
          const context = runtime.context;
          const tabs = [...runtime.tabs.values()];
          // Invalidate the context's own close callback: this teardown is
          // deliberate, so it must not be reported as a crash.
          runtime.contextSerial++;
          runtime.closing = true;
          // Every page is about to close: nothing to restore, nothing to move.
          humanViewport = null;
          appliedViewport = null;
          for (const tab of tabs) {
            yield* Effect.promise(() => tab.page.close().catch(() => undefined));
            yield* onTabPageClosed(tab);
          }
          if (screencast !== null) {
            const { stop } = screencast;
            screencast = null;
            motion?.reset();
            yield* Effect.promise(() => stop().catch(() => undefined));
          }
          if (context !== null) {
            yield* Effect.promise(() => context.close().catch(() => undefined));
          }
          runtime.context = null;
          runtime.tabs.clear();
          runtime.activeTabId = null;
          runtime.phase = "offline";
          runtime.detail = null;
          runtime.lockedByPid = null;
          yield* abandonHelp(HELP_ENDED_BY_CLOSE);
          // Keep the login origins: the persistent profile retains
          // authenticated cookies across a Chrome close, so re-enabling page
          // scripts there would bypass the protection on the next launch.
          runtime.closing = false;
          yield* lease.releaseAll;
          if (closedSomething) {
            const bot = input.byThreadId === null ? null : yield* botForThread(input.byThreadId);
            yield* recordActivity({
              kind: "control",
              summary:
                input.reason === "idle"
                  ? IDLE_CLOSE_SUMMARY
                  : bot === null
                    ? "Browser closed by you"
                    : `Browser closed by ${bot.name ?? "a bot"}`,
              status: "succeeded",
              threadId: input.byThreadId,
              botName: bot?.name ?? null,
            });
          }
          yield* notify;
          return yield* status(input.sessionId);
        }),
      );

    const closeBrowser: PersonalBrowser["Service"]["closeBrowser"] = (input) => {
      const teardown = teardownBrowser({ ...input, reason: "explicit" });
      // A bot's close is an agent operation like any other: the authority check
      // and the teardown run inside the same lease lock, so a takeover can no
      // longer land between "no human is in control" and Chrome exiting, and
      // the close cannot overtake an agent op that is already past launch.
      // The user's own close is not subject to that check, but still takes the
      // lock so it does not interleave with an op either.
      return input.byThreadId === null
        ? lease.runExclusive(teardown)
        : lease
            .runAgentOp({ threadId: input.byThreadId, operation: "close" }, teardown)
            .pipe(
              Effect.catchTag("BrowserLeaseRejected", (rejected) =>
                Effect.fail(
                  new HostOperationError(
                    "PreviewAutomationControlInterruptedError",
                    rejected.message,
                  ),
                ),
              ),
            );
    };

    /**
     * Whether anything at all still depends on the browser being up. Read
     * conservatively: every unknown is "in use", because closing under a bot
     * mid-task loses its page, and the cost of being wrong the other way is
     * one more idle minute.
     *
     * A bot between two tool calls is covered by its lease (it lapses 90s
     * after the last op) and, for the long gaps, by its task still being
     * live: a bot parked on `waiting_for_browser`, or thinking through a turn,
     * holds its tab for as long as that takes.
     */
    const browserIsInUse = Effect.gen(function* () {
      if (viewers.size > 0 || activeHelp !== null) return true;
      const view = yield* lease.view;
      // A person keeps control until they hand it back, and they may be typing
      // into the Chrome window on the laptop with no viewer attached at all —
      // signing in is exactly why the browser is headed by default.
      if (view.ownerType === "human" || view.agentActive || view.inFlightThreadId !== null) {
        return true;
      }
      const owners = new Set([...runtime.tabs.values()].map((tab) => String(tab.threadId)));
      if (owners.size === 0) return false;
      return yield* tasks.list({ statuses: LIVE_TASK_STATUSES }).pipe(
        Effect.map(({ tasks: live }) =>
          live.some((task) => task.threadId !== null && owners.has(task.threadId)),
        ),
        // Tasks unreadable: assume the browser is wanted rather than close on
        // a failed query.
        Effect.catchCause(() => Effect.succeed(true)),
      );
    });

    let idleTicks = 0;
    const idleSweep = Effect.gen(function* () {
      if (runtime.phase !== "connected" || (yield* browserIsInUse)) {
        idleTicks = 0;
        return;
      }
      idleTicks += 1;
      if (idleTicks < IDLE_CLOSE_AFTER_TICKS) return;
      idleTicks = 0;
      yield* lease.runExclusive(
        Effect.gen(function* () {
          // Re-read inside the lock: a takeover or an agent op can land between
          // the check above and the lock being granted.
          if (runtime.phase !== "connected" || (yield* browserIsInUse)) return;
          yield* Effect.logInfo("closing the shared browser after an idle stretch", {
            minutes: (IDLE_CLOSE_AFTER_TICKS * IDLE_CHECK_INTERVAL_MS) / 60_000,
          });
          yield* teardownBrowser({ sessionId: "", byThreadId: null, reason: "idle" });
        }),
      );
    });

    yield* Effect.forever(
      Effect.sleep(IDLE_CHECK_INTERVAL_MS).pipe(
        Effect.andThen(idleSweep),
        Effect.ignoreCause({ log: true }),
      ),
    ).pipe(Effect.forkScoped);

    const listFiles: PersonalBrowser["Service"]["listFiles"] = Effect.tryPromise({
      try: () => scanArtifacts(artifactsDir),
      catch: (cause) =>
        new PersonalBrowserError({ message: "Browser files could not be listed.", cause }),
    }).pipe(Effect.map((files) => ({ files: files.map(({ path: _path, ...file }) => file) })));

    const resolveFile: PersonalBrowser["Service"]["resolveFile"] = (fileId) =>
      Effect.tryPromise({
        try: () => scanArtifacts(artifactsDir),
        catch: (cause) =>
          new PersonalBrowserError({ message: "Browser files could not be listed.", cause }),
      }).pipe(
        Effect.map((files) =>
          Option.map(Option.fromNullishOr(files.find((file) => file.id === fileId)), (file) => ({
            path: file.path,
            name: file.name,
          })),
        ),
      );

    const activity: PersonalBrowser["Service"]["activity"] = (sessionId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading the backlog so nothing lands in between.
          const activityEvents = yield* PubSub.subscribe(activityPubSub);
          const statusEvents = yield* PubSub.subscribe(statusDirty);
          const initial = yield* status(sessionId);
          const head = Stream.make<ReadonlyArray<PersonalBrowserStreamItem>>(
            { _tag: "Recent", events: [...recent] },
            { _tag: "Status", status: initial },
          );
          const live = Stream.merge(
            Stream.fromSubscription(activityEvents).pipe(
              Stream.map((event): PersonalBrowserStreamItem => ({ _tag: "Activity", event })),
            ),
            Stream.fromSubscription(statusEvents).pipe(
              Stream.mapEffect(() => status(sessionId)),
              Stream.changesWith(sameStatus),
              Stream.map((next): PersonalBrowserStreamItem => ({ _tag: "Status", status: next })),
            ),
          );
          return Stream.concat(head, live);
        }),
      );

    const attachViewer: PersonalBrowser["Service"]["attachViewer"] = (input) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const outbox = yield* Queue.unbounded<string>();
          const viewer: ViewerHandle = {
            id: ++viewerSequence,
            ...input,
            outbox,
            flow: new ViewerFlow({
              adaptiveWindow: options.adaptiveAckWindow !== false,
              ...(options.streamMaxFps === undefined ? {} : { maxFps: options.streamMaxFps }),
            }),
            telemetry:
              options.streamTelemetry === false
                ? null
                : new ViewerTelemetry({ viewerId: viewerSequence, canOperate: input.canOperate }),
            scrollEndHint: motion !== null,
          };
          if (viewer.telemetry !== null) viewer.flow.setObserver(viewer.telemetry);
          viewers.set(viewer.id, viewer);
          // A phone joining mid-stretch still gets the notice on the next frame.
          framesHidden = false;
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
          if (
            viewer.telemetry !== null &&
            at - (phoneStatsLoggedAt.get(viewer) ?? -1_000) >= 1_000
          ) {
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
          humanViewport = {
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
          const seq =
            message._tag === "Pointer" || message._tag === "Key" ? message.seq : undefined;
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
