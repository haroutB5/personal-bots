// Closing the browser, the idle sweep, downloaded files and the activity feed.
import { PersonalBrowserError, ThreadId, type PersonalBrowserStreamItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { HostOperationError } from "./pageOperations.ts";
import {
  HELP_ENDED_BY_CLOSE,
  IDLE_CHECK_INTERVAL_MS,
  IDLE_CLOSE_AFTER_TICKS,
  IDLE_CLOSE_SUMMARY,
  LIVE_TASK_STATUSES,
  sameStatus,
  scanArtifacts,
} from "./browserShared.ts";
import type { BrowserCore } from "./browserCore.ts";
import type { BrowserLaunch } from "./browserLaunch.ts";
import type { BrowserTabs } from "./browserTabs.ts";
import type { PersonalBrowser } from "./PersonalBrowser.ts";

export const makeBrowserLifecycle = (core: BrowserCore, launch: BrowserLaunch, tabs: BrowserTabs) =>
  Effect.gen(function* () {
    const {
      abandonHelp,
      activityPubSub,
      artifactsDir,
      botForThread,
      launchLock,
      lease,
      motion,
      notify,
      recent,
      recordActivity,
      runtime,
      st,
      status,
      statusDirty,
      tasks,
      viewers,
    } = core;
    const { logAdblockSummary } = launch;
    const { onTabPageClosed } = tabs;

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
          st.humanViewport = null;
          st.appliedViewport = null;
          for (const tab of tabs) {
            yield* Effect.promise(() => tab.page.close().catch(() => undefined));
            yield* onTabPageClosed(tab);
          }
          if (st.screencast !== null) {
            const { stop } = st.screencast;
            st.screencast = null;
            motion?.reset();
            yield* Effect.promise(() => stop().catch(() => undefined));
          }
          if (context !== null) {
            // The serial bump above silences the context's own close callback,
            // so this is the one place a deliberate close reports its counts.
            yield* logAdblockSummary(context);
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
      if (viewers.size > 0 || st.activeHelp !== null) return true;
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

    return { activity, closeBrowser, listFiles, resolveFile };
  });

export type BrowserLifecycle = Effect.Success<ReturnType<typeof makeBrowserLifecycle>>;
