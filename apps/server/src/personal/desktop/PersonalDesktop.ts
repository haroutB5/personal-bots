/**
 * The user's real Windows desktop, shared by every bot one at a time.
 *
 * A bot's first desktop action claims the PC; it keeps it until its turn
 * ends, it calls `computer_release`, it goes {@link DESKTOP_IDLE_TIMEOUT_MS}
 * without an action, or the user stops it (Esc, or the
 * app's Stop button). Other bots wait in line inside their tool call.
 *
 * Approval is deliberately off (the owner's decision); the rails are the
 * always-visible overlay while a bot holds the PC, the stop hotkey, and the
 * helper refusing to inject input while the user's own mouse or keyboard is
 * active.
 */
// @effect-diagnostics nodeBuiltinImport:off - the helper's directory is a plain path join.
// @effect-diagnostics globalTimers:off - queue waits bridge a promise-based driver.
// @effect-diagnostics globalDate:off - status timestamps are plain ISO strings.
import * as NodePath from "node:path";

import {
  PERSONAL_DESKTOP_STOP_HOTKEY,
  type PersonalDesktopStatus,
  type PersonalDesktopStop,
  type PersonalDesktopStopReason,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import { type DesktopDriver, DesktopHelperError, WindowsDesktopDriver } from "./DesktopHelper.ts";
import {
  type DesktopClaimant,
  type DesktopHolderState,
  DESKTOP_IDLE_TIMEOUT_MS,
  DesktopLockCore,
  type HandOver,
} from "./DesktopLock.ts";
import { DesktopLiveViewHub, type LiveViewer, type LiveViewSink } from "./DesktopLiveView.ts";
import { DesktopCoordinateError, type DesktopRect, type ScreenFrame } from "./desktopGeometry.ts";
import { DesktopKeyError } from "./desktopKeys.ts";
import { planRemoteInput, type RemoteDesktopInput } from "./desktopRemote.ts";

/**
 * How long one tool call waits in line. Claude's MCP client gives up on a
 * tool call after 60 s ("The operation timed out."), so the wait has to end
 * well inside that and hand the bot a sentence it can act on.
 */
export const DESKTOP_QUEUE_WAIT_MS = 45_000;
/**
 * A bot whose wait ran out keeps its place this long, so calling again keeps
 * it in line (and its status says so) instead of starting at the back.
 */
export const DESKTOP_LINE_GRACE_MS = 60_000;
const IDLE_SWEEP_MS = 5_000;

export type DesktopActionErrorKind =
  | "unavailable"
  | "stopped"
  | "busy"
  | "user_active"
  | "locked"
  | "invalid"
  | "failed";

/** `reason` is written for the calling model. */
export class PersonalDesktopActionError extends Data.TaggedError("PersonalDesktopActionError")<{
  readonly kind: DesktopActionErrorKind;
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export const STOPPED_REASON = `The user took back control of the PC (they pressed ${PERSONAL_DESKTOP_STOP_HOTKEY} or Stop in the app). Stop using the desktop now: do not retry. Tell the user what you had done so far and ask whether they want you to continue.`;

/** What a bot hears when the owner takes the PC over from the app. */
export const TAKEN_OVER_REASON =
  "The user took control of the PC remotely from the app. Stop using the desktop now: do not retry. Tell the user what you had done so far and ask whether they want you to continue.";

/** The owner, as the PC's holder while they control it remotely. */
export const REMOTE_USER: DesktopClaimant = {
  threadId: "remote-user",
  botId: "",
  botName: "You",
  kind: "user",
};

/** Why remote control ended. */
export type RemoteControlEnd =
  | "released"
  | "closed"
  | "idle"
  | "esc"
  | "replaced"
  | "locked"
  | "stopped";

export const REMOTE_LOCKED_DETAIL = "PC is locked; it can't be unlocked remotely.";

/** What the app shows when control ends by itself; nothing when the user ended it. */
export const REMOTE_CONTROL_END_DETAIL: Readonly<Record<RemoteControlEnd, string | undefined>> = {
  released: undefined,
  closed: undefined,
  idle: "Remote control ended after 2 minutes without input.",
  esc: "Someone at the PC pressed Esc, so remote control ended.",
  replaced: "Another of your devices took control of the PC.",
  locked: REMOTE_LOCKED_DETAIL,
  stopped: "Remote control was stopped from the app.",
};

/**
 * One remote-control session: the owner holds the PC and drives it from the
 * app. Inputs run one at a time, in the order they were sent.
 */
export interface RemoteControlSession {
  /** Rejects with a user-facing PersonalDesktopActionError; nothing was done. */
  readonly input: (input: RemoteDesktopInput) => Promise<void>;
  /** Hands the PC back (toggle off, or the socket closed). */
  readonly end: (reason: "released" | "closed") => void;
  readonly active: () => boolean;
  /** Inputs queued or running (the socket drops plain moves past a backlog). */
  readonly pending: () => number;
}

export interface RemoteControlOptions {
  /** Control ended on the server's side (idle, Esc at the PC, another device, locked). */
  readonly onEnded: (reason: RemoteControlEnd, detail: string | undefined) => void;
}

export interface DesktopActionContext {
  readonly driver: DesktopDriver;
  /** The last screenshot this chat took, which its coordinates refer to. */
  readonly frame: ScreenFrame | null;
  readonly setFrame: (frame: ScreenFrame) => void;
  /** False once the user stopped this bot or it lost the PC mid-action. */
  readonly stillHeld: () => boolean;
}

export interface PersonalDesktopShape {
  readonly available: boolean;
  /**
   * Runs one desktop action for a bot: waits for the PC if another bot has
   * it, then runs `run` with the PC held. Actions of the holder run one at a
   * time even when the model issues them in parallel.
   */
  readonly act: <A>(
    claimant: DesktopClaimant,
    operation: string,
    run: (context: DesktopActionContext) => Promise<A>,
  ) => Effect.Effect<A, PersonalDesktopActionError>;
  /** The bot is done with the PC. False when it did not hold it. */
  readonly release: (threadId: string) => Effect.Effect<boolean>;
  /** The user took the PC back (hotkey or app). */
  readonly stop: (
    by: Exclude<PersonalDesktopStopReason, "idle">,
  ) => Effect.Effect<PersonalDesktopStatus>;
  /** A chat's turn ended: it lets go of the PC and leaves the line. */
  readonly threadTurnEnded: (threadId: string) => Effect.Effect<void>;
  readonly status: Effect.Effect<PersonalDesktopStatus>;
  readonly changes: Stream.Stream<PersonalDesktopStatus>;
  /**
   * The owner takes the PC for remote control from the app: a bot holding it
   * is stopped (and told the user took over), bots in line keep waiting
   * behind the owner, and no bot gets it until the session ends. Refused on
   * a locked PC. Only one session at a time: a second device takes over.
   */
  readonly takeControl: (
    options: RemoteControlOptions,
  ) => Effect.Effect<RemoteControlSession, PersonalDesktopActionError>;
  /**
   * A live view for one viewer socket (the app's Desktop view): frames go to
   * `sink` until the scope closes. Null where there is no desktop to show.
   * Watching never touches the bots' action queue (see DesktopLiveView.ts).
   */
  readonly watch: (sink: LiveViewSink) => Effect.Effect<LiveViewer | null, never, Scope.Scope>;
}

export class PersonalDesktop extends Context.Service<PersonalDesktop, PersonalDesktopShape>()(
  "t3/personal/desktop/PersonalDesktop",
) {}

interface Waiter {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: PersonalDesktopActionError) => void;
}

export interface DesktopServiceOptions {
  /** Null where there is no desktop to drive (not Windows). */
  readonly driver: DesktopDriver | null;
  readonly now?: () => number;
  readonly idleTimeoutMs?: number;
  readonly queueWaitMs?: number;
  readonly lineGraceMs?: number;
  /** Overlay left visible to screenshots, for evidence captures. */
  readonly overlayCapturable?: boolean;
  /** The app's live view; null or absent where there is no desktop. */
  readonly liveView?: DesktopLiveViewHub | null;
  /** One line per remote-control session (never its keystrokes). */
  readonly log?: (line: string) => void;
}

const iso = (millis: number) => new Date(millis).toISOString();

const REMOTE_MONITOR_TTL_MS = 10_000;

/** The primary monitor's physical rect from the helper's `info` reply. */
function primaryMonitor(info: Record<string, unknown>): DesktopRect {
  const monitors = Array.isArray(info.monitors)
    ? (info.monitors as Array<Record<string, unknown>>)
    : [];
  const primary = monitors.find((entry) => entry.primary === true) ?? monitors[0];
  if (primary === undefined) {
    throw new PersonalDesktopActionError({ kind: "unavailable", reason: "No monitor was found." });
  }
  return {
    x: Number(primary.x),
    y: Number(primary.y),
    width: Number(primary.width),
    height: Number(primary.height),
  };
}

export const overlayText = (botName: string) =>
  `${botName} is using your PC  ·  press ${PERSONAL_DESKTOP_STOP_HOTKEY} to take it back`;

export const REMOTE_OVERLAY_TEXT = `You are controlling this PC remotely  ·  press ${PERSONAL_DESKTOP_STOP_HOTKEY} here to end it`;

const isUser = (holder: DesktopClaimant | null | undefined) => holder?.kind === "user";

/** What the owner sees when one remote input fails; nothing was done. */
function remoteFailure(error: unknown): PersonalDesktopActionError {
  if (error instanceof PersonalDesktopActionError) return error;
  if (error instanceof DesktopHelperError) {
    switch (error.code) {
      case "locked":
        return new PersonalDesktopActionError({ kind: "locked", reason: REMOTE_LOCKED_DETAIL });
      case "aborted":
        return new PersonalDesktopActionError({
          kind: "stopped",
          reason: "Stopped: Esc was pressed at the PC.",
        });
      case "unavailable":
        return new PersonalDesktopActionError({ kind: "unavailable", reason: error.message });
      default:
        return new PersonalDesktopActionError({
          kind: "failed",
          reason: `The PC didn't take that input: ${error.message}`,
        });
    }
  }
  if (error instanceof DesktopCoordinateError) {
    return new PersonalDesktopActionError({
      kind: "invalid",
      reason: "That point is outside the picture of your PC.",
    });
  }
  if (error instanceof DesktopKeyError) {
    return new PersonalDesktopActionError({ kind: "invalid", reason: error.message });
  }
  return new PersonalDesktopActionError({
    kind: "failed",
    reason: `The PC didn't take that input: ${error instanceof Error ? error.message : String(error)}`,
  });
}

function helperFailure(error: unknown): PersonalDesktopActionError {
  if (error instanceof PersonalDesktopActionError) return error;
  if (error instanceof DesktopHelperError) {
    switch (error.code) {
      case "aborted":
        return new PersonalDesktopActionError({ kind: "stopped", reason: STOPPED_REASON });
      case "user_active":
        return new PersonalDesktopActionError({
          kind: "user_active",
          reason: `${error.message} Nothing more was done. Wait a few seconds, take a fresh screenshot and try again; if the user keeps using the PC, ask them whether you should continue.`,
        });
      case "locked":
        return new PersonalDesktopActionError({
          kind: "locked",
          reason: `${error.message} Nothing was clicked or typed. Never try to unlock it or type a password: ask the user to unlock their PC, then try again.`,
        });
      case "unavailable":
        return new PersonalDesktopActionError({ kind: "unavailable", reason: error.message });
      default:
        return new PersonalDesktopActionError({ kind: "failed", reason: error.message });
    }
  }
  if (error instanceof DesktopCoordinateError || error instanceof DesktopKeyError) {
    return new PersonalDesktopActionError({ kind: "invalid", reason: error.message });
  }
  return new PersonalDesktopActionError({
    kind: "failed",
    reason: `The desktop action failed: ${error instanceof Error ? error.message : String(error)}`,
  });
}

/** The service without its runtime wiring, so tests drive it with a fake driver and clock. */
export const makeDesktopService = (options: DesktopServiceOptions) =>
  Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const driver = options.driver;
    const lock = new DesktopLockCore(options.idleTimeoutMs ?? DESKTOP_IDLE_TIMEOUT_MS);

    const queueWaitMs = options.queueWaitMs ?? DESKTOP_QUEUE_WAIT_MS;
    const lineGraceMs = options.lineGraceMs ?? DESKTOP_LINE_GRACE_MS;
    const idleTimeoutMs = options.idleTimeoutMs ?? DESKTOP_IDLE_TIMEOUT_MS;
    /** When a bot whose call stopped waiting loses its place in line. */
    const lineDeadlines = new Map<string, number>();
    /** Tool calls currently waiting in line, per chat. */
    const activeWaits = new Map<string, number>();
    const waiters = new Map<string, Waiter>();
    const frames = new Map<string, ScreenFrame>();
    /** Chats the user stopped, refused until their turn ends, with what they are told. */
    const stopped = new Map<string, string>();
    const stoppedReason = (threadId: string) => stopped.get(threadId) ?? STOPPED_REASON;
    const log = options.log ?? (() => undefined);
    interface RemoteState {
      readonly options: RemoteControlOptions;
      readonly since: number;
      inputs: number;
      pending: number;
      readonly buttonsDown: Set<string>;
      monitor: DesktopRect | null;
      monitorAt: number;
    }
    /** The owner's remote-control session, while they hold the PC. */
    let remote: RemoteState | null = null;
    let lastStop: PersonalDesktopStop | null = null;
    let overlayShownFor: string | null = null;
    /** One action at a time, whoever holds the PC. */
    let actionChain: Promise<unknown> = Promise.resolve();
    const pubsub = yield* PubSub.unbounded<PersonalDesktopStatus>();

    const snapshot = (): PersonalDesktopStatus => {
      const holder = lock.holder;
      return {
        available: driver !== null,
        holder:
          holder === null
            ? null
            : {
                threadId: holder.threadId,
                botId: holder.botId,
                botName: holder.botName,
                since: iso(holder.since),
                lastActionAt: iso(holder.lastActionAt),
                kind: holder.kind ?? "bot",
              },
        waiting: lock.waiting.map((entry) => ({ ...entry })),
        lastStop,
        stopHotkey: PERSONAL_DESKTOP_STOP_HOTKEY,
      };
    };

    const publish = () => {
      Effect.runSync(PubSub.publish(pubsub, snapshot()));
    };

    /** Shows the overlay for the holder, or hides it; failures only log. */
    const syncOverlay = () => {
      if (driver === null) return;
      const holder = lock.holder;
      const wanted =
        holder === null ? null : isUser(holder) ? REMOTE_OVERLAY_TEXT : overlayText(holder.botName);
      if (wanted === overlayShownFor) return;
      overlayShownFor = wanted;
      driver
        .request("overlay", {
          show: wanted !== null,
          text: wanted ?? "",
          capturable: options.overlayCapturable === true,
        })
        .catch(() => {
          // The helper may be gone; it restarts (and the overlay with it) on
          // the next action. Forget what was shown so that action re-shows it.
          overlayShownFor = null;
        });
    };

    /** One action at a time on the helper, whoever sends it. */
    const runExclusive = <A>(task: () => Promise<A>): Promise<A> => {
      const result = actionChain.then(task, task);
      actionChain = result.catch(() => undefined);
      return result;
    };

    /**
     * The owner's session is over: it forgets its state and, when the owner
     * did not end it themselves, tells their app why. Buttons still held by a
     * drag are let go. The lock itself is the caller's business.
     */
    const finishRemote = (reason: RemoteControlEnd) => {
      const session = remote;
      if (session === null) return;
      remote = null;
      if (driver !== null) {
        for (const button of session.buttonsDown) {
          void runExclusive(() =>
            driver.request("button", { button, down: false, remote: true }),
          ).catch(() => undefined);
        }
      }
      const seconds = ((now() - session.since) / 1000).toFixed(1);
      log(`desktop remote control: ended (${reason}) after ${seconds} s, ${session.inputs} inputs`);
      if (reason !== "released" && reason !== "closed") {
        session.options.onEnded(reason, REMOTE_CONTROL_END_DETAIL[reason]);
      }
    };

    /** Asks the helper to abandon the action it is running (a stopped bot's). */
    const abortHelper = () => {
      driver?.request("abort").catch(() => undefined);
    };

    const applyHandOver = (handOver: HandOver, userEnd: RemoteControlEnd = "idle") => {
      if (handOver.previous !== null) frames.delete(handOver.previous.threadId);
      if (isUser(handOver.previous)) finishRemote(userEnd);
      if (handOver.promoted !== null) {
        const promoted = handOver.promoted.threadId;
        const waiter = waiters.get(promoted);
        waiters.delete(promoted);
        lineDeadlines.delete(promoted);
        waiter?.resolve();
        // Promoted between two of its calls: nobody is there to use the PC
        // yet, so it only keeps it for the grace period, not the full idle
        // timeout, before the next bot gets a turn.
        if ((activeWaits.get(promoted) ?? 0) === 0) {
          lock.touch(promoted, now() - idleTimeoutMs + lineGraceMs);
        }
      }
      if (handOver.previous !== null || handOver.promoted !== null) {
        syncOverlay();
        publish();
      }
    };

    const expireIdle = () => {
      const handOver = lock.expireIdle(now());
      if (handOver.previous !== null && !isUser(handOver.previous)) {
        lastStop = {
          threadId: handOver.previous.threadId,
          botName: handOver.previous.botName,
          by: "idle",
          at: iso(now()),
        };
      }
      applyHandOver(handOver);
    };

    const stopAllNow = (by: PersonalDesktopStopReason) => {
      const { stopped: holder, turnedAway } = lock.stopAll();
      lineDeadlines.clear();
      const error = new PersonalDesktopActionError({ kind: "stopped", reason: STOPPED_REASON });
      if (holder !== null && isUser(holder)) {
        finishRemote(by === "hotkey" ? "esc" : "stopped");
      } else if (holder !== null) {
        stopped.set(holder.threadId, STOPPED_REASON);
        frames.delete(holder.threadId);
        lastStop = { threadId: holder.threadId, botName: holder.botName, by, at: iso(now()) };
        // The stop key already aborted the helper's action from inside it;
        // the app's Stop has to ask.
        if (by !== "hotkey") abortHelper();
      }
      for (const entry of turnedAway) {
        stopped.set(entry.threadId, STOPPED_REASON);
        const waiter = waiters.get(entry.threadId);
        waiters.delete(entry.threadId);
        waiter?.reject(error);
      }
      syncOverlay();
      publish();
    };

    driver?.onKill(() => stopAllNow("hotkey"));

    const waitForTurn = (claimant: DesktopClaimant): Promise<void> => {
      let waiter = waiters.get(claimant.threadId);
      if (waiter === undefined) {
        let resolve!: () => void;
        let reject!: (error: PersonalDesktopActionError) => void;
        const promise = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        // A waiter nobody awaits (its call was interrupted) must not surface
        // as an unhandled rejection when the user later hits stop.
        promise.catch(() => undefined);
        waiter = { promise, resolve, reject };
        waiters.set(claimant.threadId, waiter);
      }
      return waiter.promise;
    };

    const leaveLine = (threadId: string) => {
      const waiter = waiters.get(threadId);
      waiters.delete(threadId);
      lineDeadlines.delete(threadId);
      if (lock.leaveLine(threadId)) publish();
      return waiter;
    };

    /** Claims the PC for `claimant`, waiting in line when another bot has it. */
    const acquire = (claimant: DesktopClaimant): Effect.Effect<void, PersonalDesktopActionError> =>
      Effect.suspend(() => {
        if (stopped.has(claimant.threadId)) {
          return Effect.fail(
            new PersonalDesktopActionError({
              kind: "stopped",
              reason: stoppedReason(claimant.threadId),
            }),
          );
        }
        expireIdle();
        const claim = lock.claim(claimant, now());
        if (claim.status === "granted") {
          syncOverlay();
          publish();
          return Effect.void;
        }
        lineDeadlines.delete(claimant.threadId);
        publish();
        const threadId = claimant.threadId;
        // Stops waiting without giving up the place in line.
        const keepPlace = () => {
          activeWaits.set(threadId, Math.max(0, (activeWaits.get(threadId) ?? 1) - 1));
          if (lock.waiting.some((entry) => entry.threadId === threadId)) {
            lineDeadlines.set(threadId, now() + lineGraceMs);
          }
        };
        activeWaits.set(threadId, (activeWaits.get(threadId) ?? 0) + 1);
        return Effect.tryPromise({
          try: (signal) =>
            new Promise<void>((resolve, reject) => {
              let settled = false;
              const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                keepPlace();
                const position = lock.waiting.findIndex((entry) => entry.threadId === threadId) + 1;
                const holder = lock.holder ?? claim.holder;
                reject(
                  new PersonalDesktopActionError({
                    kind: "busy",
                    reason: `${isUser(holder) ? "The user is controlling the PC remotely right now" : `${holder.botName} is using the PC`}. Nothing was done. You are number ${Math.max(1, position)} in line and keep that place for the next minute: call the same tool again now to keep waiting, or carry on with other work and tell the user you are waiting for the PC.`,
                  }),
                );
              }, queueWaitMs);
              signal.addEventListener("abort", () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                keepPlace();
              });
              waitForTurn(claimant).then(
                () => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  activeWaits.set(threadId, Math.max(0, (activeWaits.get(threadId) ?? 1) - 1));
                  resolve();
                },
                (error: unknown) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  activeWaits.set(threadId, Math.max(0, (activeWaits.get(threadId) ?? 1) - 1));
                  reject(error);
                },
              );
            }),
          catch: helperFailure,
        });
      });

    const act: PersonalDesktopShape["act"] = (claimant, operation, run) =>
      Effect.gen(function* () {
        if (driver === null) {
          return yield* new PersonalDesktopActionError({
            kind: "unavailable",
            reason: "Desktop control only works when the bots server runs on Windows.",
          });
        }
        yield* acquire(claimant);
        const result = yield* Effect.tryPromise({
          try: () =>
            runExclusive(async () => {
              // Checked again inside the chain: a stop can land while this
              // action waited behind another one of the same bot.
              if (!lock.isHolder(claimant.threadId)) {
                throw stopped.has(claimant.threadId)
                  ? new PersonalDesktopActionError({
                      kind: "stopped",
                      reason: stoppedReason(claimant.threadId),
                    })
                  : new PersonalDesktopActionError({
                      kind: "busy",
                      reason:
                        "You no longer hold the PC (it was idle too long). Take a fresh screenshot to claim it again.",
                    });
              }
              lock.touch(claimant.threadId, now());
              try {
                return await run({
                  driver,
                  frame: frames.get(claimant.threadId) ?? null,
                  setFrame: (frame) => {
                    frames.set(claimant.threadId, frame);
                  },
                  stillHeld: () => lock.isHolder(claimant.threadId),
                });
              } finally {
                lock.touch(claimant.threadId, now());
              }
            }),
          catch: (error) => {
            const failure = helperFailure(error);
            // An abort from a takeover reads as the takeover, not the stop key.
            return failure.kind === "stopped" && stopped.has(claimant.threadId)
              ? new PersonalDesktopActionError({
                  kind: "stopped",
                  reason: stoppedReason(claimant.threadId),
                })
              : failure;
          },
        }).pipe(Effect.withSpan(`PersonalDesktop.${operation}`));
        return result;
      });

    const release: PersonalDesktopShape["release"] = (threadId) =>
      Effect.sync(() => {
        const handOver = lock.release(threadId, now());
        applyHandOver(handOver);
        return handOver.previous !== null;
      });

    const stop: PersonalDesktopShape["stop"] = (by) =>
      Effect.sync(() => {
        stopAllNow(by);
        return snapshot();
      });

    /** The primary monitor's physical rect, re-read every few seconds while controlling. */
    const remoteMonitor = async (session: RemoteState): Promise<DesktopRect> => {
      if (session.monitor !== null && now() - session.monitorAt < REMOTE_MONITOR_TTL_MS) {
        return session.monitor;
      }
      const info = await driver!.request("info");
      session.monitor = primaryMonitor(info);
      session.monitorAt = now();
      return session.monitor;
    };

    const ended = () =>
      new PersonalDesktopActionError({ kind: "stopped", reason: "Remote control has ended." });

    const takeControl: PersonalDesktopShape["takeControl"] = (controlOptions) =>
      Effect.tryPromise({
        try: async () => {
          if (driver === null) {
            throw new PersonalDesktopActionError({
              kind: "unavailable",
              reason: "Remote control only works when the bots server runs on Windows.",
            });
          }
          const info = await driver.request("info");
          if (info.locked === true) {
            throw new PersonalDesktopActionError({ kind: "locked", reason: REMOTE_LOCKED_DETAIL });
          }
          const monitor = primaryMonitor(info);
          // Another device of the owner's had it: that session ends, the PC stays theirs.
          if (remote !== null) finishRemote("replaced");
          const previous = lock.takeOver(REMOTE_USER, now());
          if (previous !== null) {
            stopped.set(previous.threadId, TAKEN_OVER_REASON);
            frames.delete(previous.threadId);
            lastStop = {
              threadId: previous.threadId,
              botName: previous.botName,
              by: "app",
              at: iso(now()),
            };
            abortHelper();
          }
          const session: RemoteState = {
            options: controlOptions,
            since: now(),
            inputs: 0,
            pending: 0,
            buttonsDown: new Set(),
            monitor,
            monitorAt: now(),
          };
          remote = session;
          log(
            `desktop remote control: started${previous === null ? "" : ` (took the PC from ${previous.botName})`}, ${lock.waiting.length} waiting`,
          );
          syncOverlay();
          publish();
          const handle: RemoteControlSession = {
            active: () => remote === session,
            pending: () => session.pending,
            end: (reason) => {
              if (remote !== session) return;
              applyHandOver(lock.release(REMOTE_USER.threadId, now()), reason);
            },
            input: async (input) => {
              if (remote !== session) throw ended();
              session.pending += 1;
              try {
                lock.touch(REMOTE_USER.threadId, now());
                const command = planRemoteInput(input, await remoteMonitor(session));
                await runExclusive(async () => {
                  if (remote !== session) throw ended();
                  await driver.request(command.cmd, command.params, command.timeoutMs);
                });
                session.inputs += 1;
                const button = command.params.button;
                if (command.cmd === "button" && typeof button === "string") {
                  if (command.params.down === true) session.buttonsDown.add(button);
                  else session.buttonsDown.delete(button);
                }
              } catch (error) {
                const failure = remoteFailure(error);
                if (failure.kind === "locked" && remote === session) {
                  applyHandOver(lock.release(REMOTE_USER.threadId, now()), "locked");
                }
                throw failure;
              } finally {
                session.pending -= 1;
              }
            },
          };
          return handle;
        },
        catch: remoteFailure,
      });

    const threadTurnEnded: PersonalDesktopShape["threadTurnEnded"] = (threadId) =>
      Effect.sync(() => {
        stopped.delete(threadId);
        const waiter = leaveLine(threadId);
        waiter?.reject(
          new PersonalDesktopActionError({ kind: "busy", reason: "Your turn ended." }),
        );
        applyHandOver(lock.release(threadId, now()));
      });

    return {
      service: PersonalDesktop.of({
        available: driver !== null,
        act,
        release,
        stop,
        threadTurnEnded,
        takeControl,
        status: Effect.sync(snapshot),
        changes: Stream.fromPubSub(pubsub),
        watch: (sink) =>
          Effect.acquireRelease(
            Effect.sync(() => options.liveView?.attach(sink) ?? null),
            (viewer) => Effect.sync(() => viewer?.detach()),
          ),
      }),
      /**
       * Drops a holder idle past the timeout and bots whose place in line
       * lapsed; the layer runs it on a timer.
       */
      sweep: Effect.sync(() => {
        const at = now();
        for (const [threadId, deadline] of lineDeadlines) {
          if (at >= deadline) leaveLine(threadId);
        }
        expireIdle();
      }),
    };
  });

const ACTIVE_SESSION_STATUSES = new Set(["starting", "running"]);

export const layer = Layer.effect(
  PersonalDesktop,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const platform = yield* HostProcessPlatform;
    const driver =
      platform === "win32"
        ? new WindowsDesktopDriver(NodePath.join(config.stateDir, "desktop-helper"))
        : null;
    yield* Effect.addFinalizer(() => Effect.sync(() => driver?.dispose()));
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    // The live view captures through its own process, never the bots' helper.
    const liveView =
      platform === "win32"
        ? new DesktopLiveViewHub({
            createDriver: () =>
              new WindowsDesktopDriver(
                NodePath.join(config.stateDir, "desktop-helper"),
                "RunCapture",
              ),
            log: (line) => {
              runFork(Effect.logInfo(line));
            },
          })
        : null;
    yield* Effect.addFinalizer(() => Effect.sync(() => liveView?.dispose()));
    const { service, sweep } = yield* makeDesktopService({
      driver,
      overlayCapturable: process.env.PB_DESKTOP_OVERLAY_CAPTURABLE === "1",
      liveView,
      log: (line) => {
        runFork(Effect.logInfo(line));
      },
    });
    // A turn that ends lets go of the PC: nobody should hold the user's
    // desktop across a finished reply, and a stopped chat may try again on
    // the user's next message.
    const events = yield* engine.subscribeDomainEvents;
    yield* Stream.runForEach(events, (event) =>
      event.type === "thread.session-set" &&
      !ACTIVE_SESSION_STATUSES.has(event.payload.session.status)
        ? service.threadTurnEnded(event.payload.threadId)
        : Effect.void,
    ).pipe(Effect.forkScoped);
    yield* sweep.pipe(
      Effect.andThen(Effect.sleep(IDLE_SWEEP_MS)),
      Effect.forever,
      Effect.forkScoped,
    );
    return service;
  }),
);

export type { DesktopClaimant, DesktopHolderState };
