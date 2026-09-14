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
  type PersonalBrowserStatus,
  type PersonalBrowserStreamItem,
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
import { AGENT_LEASE_TTL_MS, BrowserLease } from "./BrowserLease.ts";
import {
  type BrowserContextHandle,
  type BrowserDriver,
  type BrowserPage,
  makePlaywrightDriver,
  type ScreencastMeta,
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
}

const RECENT_ACTIVITY_LIMIT = 30;
const RESTORE_NAVIGATE_TIMEOUT_MS = 30_000;
const TIMELINE_LIMIT = 20;
const PAGE_INFO_REFRESH_MS = 1_500;
const MAX_LISTED_FILES = 300;
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
    const lease = yield* BrowserLease;
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
    };
    const pageTitles = new WeakMap<BrowserPage, string>();
    const viewers = new Map<number, ViewerHandle>();
    let viewerSequence = 0;
    let screencast: { readonly page: BrowserPage; readonly stop: () => Promise<void> } | null =
      null;
    let lastPageInfoRefresh = 0;

    const launchLock = yield* Semaphore.make(1);
    const screencastLock = yield* Semaphore.make(1);
    const statusDirty = yield* PubSub.unbounded<void>();
    const activityPubSub = yield* PubSub.unbounded<PersonalBrowserActivityEvent>();
    const recent: PersonalBrowserActivityEvent[] = [];

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

    const onContextClosed = (serial: number) =>
      Effect.gen(function* () {
        if (serial !== runtime.contextSerial) return;
        const tabs = [...runtime.tabs.values()];
        runtime.context = null;
        runtime.tabs.clear();
        runtime.activeTabId = null;
        screencast = null;
        runtime.phase = runtime.closing ? "offline" : "crashed";
        runtime.detail = runtime.closing
          ? null
          : "Chrome exited. It restarts on the next browser action or when you take control.";
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
        return context;
      }),
    );

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        runtime.closing = true;
        await runtime.context?.close().catch(() => undefined);
      }),
    );

    // Lease changes (takeover, return, agent switch) are status changes.
    yield* lease.changes.pipe(
      Stream.runForEach(() => notify),
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
        const tab: TabEntry = { tabId: snapshot.tabId, threadId, page, title: "", timeline: [] };
        runtime.tabs.set(tab.tabId, tab);
        page.onClose(() => runFork(onTabPageClosed(tab)));
        return tab;
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
        yield* lease.releaseThread(threadId);
      });

    const statusOf = (tab: TabEntry | undefined): PreviewAutomationStatus => ({
      available: runtime.phase !== "locked",
      visible: viewers.size > 0 || !options.headless,
      tabId: tab?.tabId ?? null,
      url: tab !== undefined && openPage(tab.page) ? tab.page.url() : null,
      title: tab?.title ?? null,
      loading: runtime.phase === "starting",
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
        yield* setActive(tab);
        switch (request.operation) {
          case "snapshot": {
            const snapshot = yield* attempt({}, () => captureSnapshot(tab.page, tab.timeline));
            tab.title = snapshot.title;
            return { tab, result: snapshot };
          }
          case "click": {
            const input = request.input as PreviewAutomationClickInput;
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
            yield* attempt({}, () => performPress(tab.page, input));
            return { tab, result: { tabId: tab.tabId } };
          }
          case "scroll": {
            const input = request.input as PreviewAutomationScrollInput;
            yield* attempt(input, () => performScroll(tab.page, input, timeoutMs));
            return { tab, result: { tabId: tab.tabId } };
          }
          case "evaluate": {
            const input = request.input as PreviewAutomationEvaluateInput;
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
            yield* attempt({}, () =>
              tab.page.setViewport(
                setting._tag === "fill" ? null : { width: setting.width, height: setting.height },
              ),
            );
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
          const current = exit.value.tab.page.url();
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
        const tab = latestTabForThread(input.threadId);
        if (tab === undefined) {
          return yield* Effect.fail(
            new HostOperationError(
              "PreviewAutomationTabNotFoundError",
              "No open browser tab for this thread. Open the matching site first.",
            ),
          );
        }
        yield* setActive(tab);
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
              yield* recordActivity({
                kind: "type",
                summary: "Filled a saved login",
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

    const returnToAgent: PersonalBrowser["Service"]["returnToAgent"] = (sessionId) =>
      Effect.gen(function* () {
        const before = yield* lease.view;
        yield* lease.returnToAgent;
        if (before.ownerType === "human") {
          yield* recordActivity({
            kind: "control",
            summary: "Returned control to the agent",
            status: "succeeded",
            threadId: null,
            botName: null,
          });
        }
        yield* notify;
        return yield* status(sessionId);
      });

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
      }
    };

    const handleViewerMessage: PersonalBrowser["Service"]["handleViewerMessage"] = (viewer, raw) =>
      Effect.gen(function* () {
        const decoded = yield* decodeInputMessage(raw).pipe(Effect.option);
        if (Option.isNone(decoded)) return yield* rejectInput(viewer, "Malformed input message.");
        if (!viewer.canOperate) {
          return yield* rejectInput(
            viewer,
            "This session is read-only and cannot control the browser.",
          );
        }
        if (!(yield* lease.isHumanController(viewer.sessionId))) {
          return yield* rejectInput(viewer, "Take control before interacting with the browser.");
        }
        const page = runtime.phase === "connected" ? viewportPage() : null;
        if (page === null) return yield* rejectInput(viewer, "The browser has no open page yet.");
        const exit = yield* Effect.exit(
          Effect.tryPromise({
            try: () => dispatchHumanInput(page, decoded.value),
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
      returnToAgent,
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
