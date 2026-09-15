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
  PersonalBrowserError,
  PersonalBrowserInputMessage,
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

import * as ServerConfig from "../../config.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import { AGENT_LEASE_TTL_MS, BrowserLease, PERSONAL_BROWSER_PROFILE_ID } from "./BrowserLease.ts";
import {
  type BrowserContextHandle,
  type BrowserDriver,
  type BrowserPage,
  makePlaywrightDriver,
  type ScreencastMeta,
  type ViewportOverride,
  type ViewportSize,
} from "./driver.ts";
import {
  captureSnapshot,
  classifyPageError,
  HostOperationError,
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

/** Chrome did not start; `message` is Playwright's own error text. */
class PersonalBrowserLaunchError extends Data.TaggedError("PersonalBrowserLaunchError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface ViewerHandle {
  readonly id: number;
  readonly sessionId: string;
  readonly canOperate: boolean;
  /** Frames and control replies; sliding so a slow phone drops frames, not the server. */
  readonly outbox: Queue.Queue<Uint8Array | string>;
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
    }) => Effect.Effect<ReadonlyArray<PersonalLoginFilledField>, HostOperationError>;
    readonly attachViewer: (input: {
      readonly sessionId: string;
      readonly canOperate: boolean;
    }) => Effect.Effect<ViewerHandle, never, Scope.Scope>;
    readonly handleViewerMessage: (viewer: ViewerHandle, raw: string) => Effect.Effect<void>;
  }
>()("t3/personal/browser/PersonalBrowser") {}

export interface PersonalBrowserOptions {
  readonly driver: BrowserDriver;
  readonly headless: boolean;
  readonly executablePath: string | undefined;
}

/**
 * Headed by default so the user can sign in on the laptop.
 * `T3CODE_PERSONAL_BROWSER_HEADLESS=1` runs headless;
 * `T3CODE_PERSONAL_BROWSER_EXECUTABLE` overrides the system Chrome channel.
 */
export const optionsFromEnvironment = (): PersonalBrowserOptions => ({
  driver: makePlaywrightDriver(),
  headless: /^(1|true|yes)$/i.test(process.env.T3CODE_PERSONAL_BROWSER_HEADLESS ?? ""),
  executablePath: process.env.T3CODE_PERSONAL_BROWSER_EXECUTABLE?.trim() || undefined,
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
}

const RECENT_ACTIVITY_LIMIT = 30;
const RESTORE_NAVIGATE_TIMEOUT_MS = 30_000;
/** The server's own navigation of the fresh tab a saved login is filled into. */
const FILL_NAVIGATE_TIMEOUT_MS = 20_000;
const TIMELINE_LIMIT = 20;
const PAGE_INFO_REFRESH_MS = 1_500;
const MAX_LISTED_FILES = 300;
/** A 390px phone gets 780px frames: exactly the screencast's maxWidth, so crisp and uncapped. */
const PHONE_DEVICE_SCALE_FACTOR = 2;
const ARTIFACT_SCAN_DEPTH = 3;

const decodeInputMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersonalBrowserInputMessage),
);

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
      // Origins where a model-provided script was allowed to run. A script can
      // register a service worker, which survives the tab, the navigation and
      // the Chrome process, so no saved login is ever filled on such an origin
      // again in this profile.
      taintedOrigins: new Set<string>(),
    };
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
              taintedOrigins: [],
            }),
          ),
        ),
      ),
    );
    if (Option.isSome(restored)) {
      runtime.loginUsed = restored.value.loginUsed;
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
        taintedOrigins: [...runtime.taintedOrigins],
      }),
    );

    const pageTitles = new WeakMap<BrowserPage, string>();
    const viewers = new Map<number, ViewerHandle>();
    let viewerSequence = 0;
    let screencast: { readonly page: BrowserPage; readonly stop: () => Promise<void> } | null =
      null;
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
    } | null = null;

    const notify = PubSub.publish(statusDirty, undefined).pipe(Effect.asVoid);

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
        const page = runtime.phase === "connected" ? viewportPage() : null;
        const pageInfo = page === null ? null : { url: page.url(), title: titleFor(page) };
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

    const onFrame = (jpeg: Uint8Array, meta: ScreencastMeta) => {
      const frame = encodePersonalBrowserFrame(jpeg, meta);
      for (const viewer of viewers.values()) Queue.offerUnsafe(viewer.outbox, frame);
      // Frames only arrive when the page repaints, so they double as a cheap
      // trigger for noticing human navigation (url/title) without polling.
      const now = performance.now();
      if (now - lastPageInfoRefresh > PAGE_INFO_REFRESH_MS) {
        lastPageInfoRefresh = now;
        runFork(Effect.andThen(refreshPageInfo, notify));
      }
    };

    /** Screencast runs exactly while a viewer is attached to a live page. */
    const syncScreencast = screencastLock.withPermit(
      Effect.gen(function* () {
        const target = viewers.size > 0 && runtime.phase === "connected" ? viewportPage() : null;
        if (screencast !== null && (target === null || screencast.page !== target)) {
          const { stop } = screencast;
          screencast = null;
          yield* Effect.promise(() => stop().catch(() => undefined));
        }
        if (target !== null && screencast === null) {
          const stop = yield* Effect.tryPromise(() => target.startScreencast(onFrame)).pipe(
            Effect.option,
          );
          if (Option.isSome(stop)) screencast = { page: target, stop: stop.value };
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
        runtime.context = null;
        runtime.tabs.clear();
        runtime.activeTabId = null;
        screencast = null;
        // Its page died with Chrome; a relaunch re-applies it if still wanted.
        appliedViewport = null;
        runtime.phase = runtime.closing ? "offline" : "crashed";
        runtime.detail = runtime.closing
          ? null
          : "Chrome exited. It restarts on the next browser action or when you take control.";
        activeHelp = null;
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
          if (
            activeHelp !== null &&
            view.ownerType === "agent" &&
            view.ownerId !== null &&
            view.ownerId !== activeHelp.request.threadId
          ) {
            activeHelp = null;
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
      Effect.sync(() => {
        if (activeHelp !== null && activeHelp.request.threadId !== threadId) activeHelp = null;
      });

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
        };
        runtime.tabs.set(tab.tabId, tab);
        page.onClose(() => runFork(onTabPageClosed(tab)));
        return tab;
      });

    /** Closes one thread's tabs on `origin`, except the one being kept. */
    const retireTabsOnOrigin = (input: {
      readonly threadId: ThreadId;
      readonly origin: string;
      readonly except: TabEntry;
    }) =>
      Effect.gen(function* () {
        // Collected first: closing a tab reaps it out of the same map.
        const doomed = [...runtime.tabs.values()].filter(
          (tab) =>
            tab !== input.except &&
            tab.threadId === input.threadId &&
            openPage(tab.page) &&
            originOf(tab.page.url()) === input.origin,
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

    const navigateTab = (tab: TabEntry, url: string, readiness: string, timeoutMs: number) =>
      attempt({}, () =>
        tab.page.goto(url, {
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

    const runOperation = (request: PreviewAutomationRequest) =>
      Effect.gen(function* () {
        const timeoutMs = request.timeoutMs;
        switch (request.operation) {
          case "open": {
            const input = request.input as PreviewAutomationOpenInput;
            const resolved = input.url === undefined ? undefined : resolveBrowserUrl(input.url);
            if (resolved !== undefined && !resolved.ok) return yield* rejectUrl(resolved.reason);
            const url = resolved?.ok ? resolved.url : undefined;
            const reused = input.reuseExistingTab === false ? undefined : tabForRequest(request);
            const tab = reused ?? (yield* createTab(request.threadId, url));
            if (url !== undefined) yield* navigateTab(tab, url, "load", timeoutMs);
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
            // Navigating a thread with no tab yet opens one, like a fresh browser window.
            const tab =
              tabForRequest(request) ?? (yield* createTab(request.threadId, resolved.url));
            yield* navigateTab(
              tab,
              resolved.url,
              input.readiness ?? "load",
              input.timeoutMs ?? timeoutMs,
            );
            yield* setActive(tab);
            yield* syncPreviewStatus(tab);
            return { tab, result: statusOf(tab) };
          }
          default:
            break;
        }
        const tab = yield* requireTab(request);
        refreshCredentialProtection(tab);
        yield* setActive(tab);
        if (runtime.loginUsed && request.operation === "evaluate") {
          return yield* rejectUrl(
            "Page scripts are disabled after a saved login is used, so browser or page state cannot reveal it.",
          );
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
              performClick(tab.page, input, input.timeoutMs ?? timeoutMs),
            );
            return { tab, result: { tabId: tab.tabId } };
          }
          case "type": {
            const input = request.input as PreviewAutomationTypeInput;
            yield* attempt(input, () => performType(tab.page, input, input.timeoutMs ?? timeoutMs));
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
            yield* taintForScript(tab);
            return {
              tab,
              result: yield* attempt({}, () => performEvaluate(tab.page, input, timeoutMs)),
            };
          }
          case "waitFor": {
            const input = request.input as PreviewAutomationWaitForInput;
            yield* attempt(input, () =>
              performWaitFor(tab.page, input, input.timeoutMs ?? timeoutMs),
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

    const handleAutomationRequest: PersonalBrowser["Service"]["handleAutomationRequest"] = (
      request,
    ) => {
      // Fast path: status never launches Chrome, never takes the lease and
      // never waits behind an in-flight op (MCP gives it a 500ms budget).
      if (request.operation === "status")
        return Effect.sync(() => statusOf(tabForRequest(request)));
      const execute = Effect.gen(function* () {
        yield* clearHelpForAgentSwitch(request.threadId);
        const startedAt = yield* nowIso;
        // Belt and braces: no operation may outlive its own budget while
        // holding the lease, even one whose driver call ignores timeouts.
        // (Effect.timeoutFail does not exist in this Effect version; a
        // timeoutOption mapped to the broker's timeout tag is equivalent.)
        const bounded = runOperation(request).pipe(
          Effect.timeoutOption(request.timeoutMs + 1_000),
          Effect.flatMap((result) =>
            Option.isSome(result)
              ? Effect.succeed(result.value)
              : Effect.fail(
                  new HostOperationError(
                    "PreviewAutomationTimeoutError",
                    `Browser operation timed out after ${request.timeoutMs}ms.`,
                  ),
                ),
          ),
        );
        const exit = yield* Effect.exit(Effect.andThen(ensureLaunched, bounded));
        const tab = Exit.isSuccess(exit) ? exit.value.tab : tabForRequest(request);
        const completedAt = yield* nowIso;
        if (tab !== undefined) {
          tab.timeline.push({
            id: NodeCrypto.randomUUID(),
            action: request.operation,
            status: Exit.isSuccess(exit) ? "succeeded" : "failed",
            startedAt,
            completedAt,
            ...(Exit.isFailure(exit) ? { error: firstLine(String(Cause.squash(exit.cause))) } : {}),
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
        if (Exit.isSuccess(exit) && openPage(exit.value.tab.page)) {
          const current = safeUrl(exit.value.tab, exit.value.tab.page.url());
          if (/^https?:\/\//i.test(current)) yield* lease.recordPageUrl(current);
        }
        return yield* Exit.match(exit, {
          onSuccess: ({ result }) => Effect.succeed(result as unknown),
          onFailure: (cause) => Effect.failCause(cause),
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

    const fillLogin: PersonalBrowser["Service"]["fillLogin"] = (input) => {
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
        if (runtime.taintedOrigins.has(input.expectedOrigin)) {
          return yield* Effect.fail(
            new HostOperationError(
              "PreviewAutomationExecutionError",
              `A page script was run on ${input.expectedOrigin} in this browser, so saved logins are no longer filled there. Page state from that script can outlive the tab.`,
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
        // The bot's own tabs on this origin are retired with the fill: they can
        // hold script the bot installed, and closing them also routes its next
        // tool call to the tab the server opened rather than the old one.
        yield* retireTabsOnOrigin({
          threadId: input.threadId,
          origin: input.expectedOrigin,
          except: tab,
        });
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
          Effect.ensuring(notify),
        );
    };

    const takeControl: PersonalBrowser["Service"]["takeControl"] = (sessionId) =>
      Effect.gen(function* () {
        const before = yield* lease.view;
        yield* lease.takeControl(sessionId);
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
          const request: PersonalBrowserHelpRequest = {
            threadId: input.threadId,
            botId: input.botId,
            botName: input.botName,
            reason: input.reason,
            requestedAt: yield* nowIso,
          };
          activeHelp = { request, taskId: input.taskId };
          yield* recordActivity({
            kind: "control",
            summary: `${input.botName} asked for help: ${input.reason}`,
            status: "succeeded",
            threadId: input.threadId,
            botName: input.botName,
          });
          yield* notify;
          return request;
        }),
      );

    const returnToAgent: PersonalBrowser["Service"]["returnToAgent"] = (sessionId) =>
      Effect.gen(function* () {
        const before = yield* lease.view;
        yield* lease.returnToAgent;
        // The agent gets its own viewport back before it can run another op.
        yield* syncHumanViewport;
        if (before.ownerType === "human") {
          const finishedHelp = activeHelp;
          activeHelp = null;
          yield* recordActivity({
            kind: "control",
            summary:
              finishedHelp === null ? "Returned control to the agent" : "You finished helping",
            status: "succeeded",
            threadId: finishedHelp?.request.threadId ?? null,
            botName: finishedHelp?.request.botName ?? null,
          });
          if (finishedHelp !== null) {
            yield* tasks
              .resumeFromUser({
                taskId: finishedHelp.taskId,
                noteId: `browser-help:${finishedHelp.request.requestedAt}`,
                note: "The user finished helping in the browser. Continue the task.",
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

    const closeBrowser: PersonalBrowser["Service"]["closeBrowser"] = (input) => {
      // Under the launch lock so a close can never interleave with a launch and
      // leave a live context behind an "offline" phase.
      const teardown = launchLock.withPermit(
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
          activeHelp = null;
          // Keep loginUsed: the persistent profile retains authenticated
          // cookies across a Chrome close, so re-enabling page scripts here
          // would bypass the protection on the next launch.
          runtime.closing = false;
          yield* lease.releaseAll;
          if (closedSomething) {
            const bot = input.byThreadId === null ? null : yield* botForThread(input.byThreadId);
            yield* recordActivity({
              kind: "control",
              summary:
                bot === null ? "Browser closed by you" : `Browser closed by ${bot.name ?? "a bot"}`,
              status: "succeeded",
              threadId: input.byThreadId,
              botName: bot?.name ?? null,
            });
          }
          yield* notify;
          return yield* status(input.sessionId);
        }),
      );
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
          const outbox = yield* Queue.sliding<Uint8Array | string>(4);
          const viewer: ViewerHandle = { id: ++viewerSequence, ...input, outbox };
          viewers.set(viewer.id, viewer);
          yield* syncScreencast;
          yield* notify;
          return viewer;
        }),
        (viewer) =>
          Effect.gen(function* () {
            viewers.delete(viewer.id);
            yield* Queue.shutdown(viewer.outbox);
            // A phone that disconnects mid-control leaves the page as it found it.
            yield* syncHumanViewport;
            yield* syncScreencast;
            yield* notify;
          }),
      );

    const rejectInput = (viewer: ViewerHandle, reason: string) =>
      Queue.offer(viewer.outbox, JSON.stringify({ _tag: "InputRejected", reason })).pipe(
        Effect.asVoid,
      );

    const dispatchHumanInput = async (page: BrowserPage, message: PersonalBrowserInputMessage) => {
      switch (message._tag) {
        case "Pointer":
          if (message.action === "tap") return page.mouseClick(message.x, message.y);
          await page.mouseMove(message.x, message.y);
          if (message.action === "down") await page.mouseDown();
          if (message.action === "up") await page.mouseUp();
          return;
        case "Wheel":
          await page.mouseMove(message.x, message.y);
          return page.mouseWheel(message.deltaX, message.deltaY);
        case "Key":
          return page.keyPress([...(message.modifiers ?? []), message.key].join("+"));
        case "InsertText":
          return page.insertText(message.text);
        case "Navigate": {
          const resolved = resolveBrowserUrl(message.url);
          if (!resolved.ok)
            throw new HostOperationError("PreviewAutomationExecutionError", resolved.reason);
          return page.goto(resolved.url, { waitUntil: "commit", timeoutMs: 15_000 });
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
      }
    };

    const handleViewerMessage: PersonalBrowser["Service"]["handleViewerMessage"] = (viewer, raw) =>
      Effect.gen(function* () {
        const decoded = yield* decodeInputMessage(raw).pipe(Effect.option);
        if (Option.isNone(decoded)) return yield* rejectInput(viewer, "Malformed input message.");
        const message = decoded.value;
        // A viewport request is the client's own housekeeping, not something
        // the user did, so refusing it (a race with Return to bot) is silent.
        const refuse = (reason: string) =>
          message._tag === "Viewport" ? Effect.void : rejectInput(viewer, reason);
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
        const page = runtime.phase === "connected" ? viewportPage() : null;
        if (page === null) return yield* rejectInput(viewer, "The browser has no open page yet.");
        const exit = yield* Effect.exit(
          Effect.tryPromise({
            try: () => dispatchHumanInput(page, message),
            catch: (cause) => classifyPageError(cause),
          }),
        );
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          yield* rejectInput(viewer, error instanceof Error ? error.message : "Input failed.");
        }
      });

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

    return PersonalBrowser.of({
      status,
      takeControl,
      requestHelp,
      returnToAgent,
      closeBrowser,
      listFiles,
      resolveFile,
      releaseThread,
      activity,
      handleAutomationRequest,
      fillLogin,
      attachViewer,
      handleViewerMessage,
    });
  });

export const makeLayer = (options: PersonalBrowserOptions) =>
  Layer.effect(PersonalBrowser, make(options));

export const layer = Layer.unwrap(Effect.sync(() => makeLayer(optionsFromEnvironment())));
