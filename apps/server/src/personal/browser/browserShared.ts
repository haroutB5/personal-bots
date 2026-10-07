// @effect-diagnostics nodeBuiltinImport:off - the Chrome profile-lock probe needs readlink and open flags, and the artifact scan must skip symlinks.
// The shared browser service's module-level parts: its state types, timings, texts and small helpers.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  PERSONAL_TASK_TERMINAL_STATUSES,
  PersonalBrowserInputMessage,
  PersonalBrowserViewerMessage,
  PersonalTaskStatus,
  ThreadId,
  type PersonalBrowserFile,
  type PersonalBrowserStatus,
  type PreviewAutomationActionEvent,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { type BrowserPage, type PageDialog } from "./driver.ts";
import { HostOperationError } from "./pageOperations.ts";
import { type StreamInputKind, ViewerTelemetry } from "./streamTelemetry.ts";
import { ViewerFlow } from "./viewerFlow.ts";

/** Chrome did not start; `message` is Playwright's own error text. */
export class PersonalBrowserLaunchError extends Data.TaggedError("PersonalBrowserLaunchError")<{
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

export type Phase = "offline" | "starting" | "connected" | "crashed" | "locked";

export interface TabEntry {
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

export const RECENT_ACTIVITY_LIMIT = 30;
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
export const CONTROL_CHECK_INTERVAL_MS = 5_000;
export const IDLE_CLOSE_AFTER_TICKS = 10;
export const IDLE_CHECK_INTERVAL_MS = 60_000;
export const IDLE_CLOSE_SUMMARY = "Browser closed after 10 minutes with nobody using it";
/** Statuses a task can still leave on its own; its thread may need the browser. */
export const LIVE_TASK_STATUSES = PersonalTaskStatus.literals.filter(
  (status) => !PERSONAL_TASK_TERMINAL_STATUSES.includes(status),
);
export const RESTORE_NAVIGATE_TIMEOUT_MS = 30_000;
/** The server's own navigation of the fresh tab a saved login is filled into. */
export const FILL_NAVIGATE_TIMEOUT_MS = 20_000;
export const TIMELINE_LIMIT = 20;
/**
 * The broker treats a request it has not heard back on within its timeout as
 * a dead host and evicts it, which fails every bot's next call until the host
 * re-registers. So the host always answers first: a whole request (lease wait
 * and Chrome start included) finishes this long before the broker's deadline,
 * and driver calls get a further margin so their own, more specific, timeout
 * message is what the bot sees.
 */
export const HOST_REPLY_MARGIN_MS = 750;
export const DRIVER_TIMEOUT_MARGIN_MS = 1_500;
export const MIN_DRIVER_TIMEOUT_MS = 250;
/** How long `unstick` waits for a page to answer before stopping its script. */
export const UNSTICK_PROBE_MS = 1_000;

/** The driver's budget within a request's broker timeout. */
export const driverTimeoutFor = (requestTimeoutMs: number, inputTimeoutMs?: number) =>
  Math.max(
    MIN_DRIVER_TIMEOUT_MS,
    Math.min(inputTimeoutMs ?? requestTimeoutMs, requestTimeoutMs) - DRIVER_TIMEOUT_MARGIN_MS,
  );

export const describeDialog = (dialog: PageDialog) => {
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
export const PAGE_INFO_REFRESH_MS = 1_500;
export const MAX_LISTED_FILES = 300;
/** A 390px phone gets 780px frames: exactly the screencast's maxWidth, so crisp and uncapped. */
export const PHONE_DEVICE_SCALE_FACTOR = 2;
export const ARTIFACT_SCAN_DEPTH = 3;

// Continuations for a help request that ended without Return to bot. The bot's
// task is parked on waiting_for_browser, and only a resume brings it back.
export const HELP_ENDED_BY_CLOSE =
  "The shared browser was closed before the user finished helping, so your browser help request was cancelled. Tell the user in one sentence what you still need. Reopen the page only if the task still needs it, and call request_browser_help again if you get blocked.";
export const HELP_ENDED_BY_CRASH =
  "Chrome exited before the user finished helping, so your browser help request was cancelled. Reopen the page and call request_browser_help again if you are still blocked, or tell the user in one sentence what you still need.";
export const HELP_ENDED_BY_SWITCH =
  "Another chat started using the shared browser before the user finished helping, so your browser help request was cancelled. Tell the user in one sentence what you still need, or call request_browser_help again once you have the browser back.";

export const decodeInputMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersonalBrowserInputMessage),
);
export const encodeViewerMessage = Schema.encodeSync(
  Schema.fromJsonString(PersonalBrowserViewerMessage),
);
export const encodeStreamLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Only the kind of input is ever recorded, never what it did or where. */
export const streamInputKind = (message: PersonalBrowserInputMessage): StreamInputKind => {
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

export const FRAMES_HIDDEN_REASON =
  "Hidden while a bot fills a saved password. The view returns when the page moves on, or when you take control.";

export const firstLine = (value: string) => value.split("\n")[0]?.trim() || "Unknown error";

export const hostOf = (url: string) => {
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

export async function detectProfileLock(
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

export interface ScannedFile extends PersonalBrowserFile {
  readonly path: string;
}

export const fileKind = (relativePath: string): PersonalBrowserFile["kind"] => {
  if (/^downloads[\\/]/i.test(relativePath)) return "download";
  if (/\.(png|jpe?g|webp)$/i.test(relativePath)) return "screenshot";
  if (/\.(webm|mp4|mov)$/i.test(relativePath)) return "recording";
  return "other";
};

/** Ids are hashes of the relative path, so a client can never name a path directly. */
export const fileIdFor = (relativePath: string) =>
  NodeCrypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 32);

export async function scanArtifacts(root: string): Promise<ReadonlyArray<ScannedFile>> {
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

export const sameStatus = (left: PersonalBrowserStatus, right: PersonalBrowserStatus) =>
  JSON.stringify(left) === JSON.stringify(right);
