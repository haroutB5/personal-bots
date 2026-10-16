/**
 * The call provider: one call at a time, mounted once at the shell so the call
 * survives every navigation.
 *
 * It is deliberately thin. The engine (`voiceCallController`, the live socket
 * and the audio) is loaded on the first tap, so the chat and composer bundles
 * grow by nothing but the call button; the AudioContext is still created
 * synchronously in that tap handler, before the lazy import resolves, because
 * iOS only starts audio from a tap.
 *
 * The pre-ship review's client fixes live here (15 Oct 2026):
 * - the start slot is reserved synchronously, so two taps mint one pass;
 * - the bot status the voice reads is bound to the CALL's own thread, and the
 *   last known answer is kept when that chat is not mounted, so navigating away
 *   can never look like the bot finishing its turn;
 * - the screen wake lock is held for the call and taken again when the app
 *   comes back to the foreground;
 * - the server calls go through `voiceCallApi`, imported on the tap rather than
 *   on every shell render.
 *
 * High-frequency state (captions, the ring's level, the timer) never
 * re-renders the app: the snapshot lives in a small external store that only
 * the call screen and the bar subscribe to, coalesced to about ten updates a
 * second.
 *
 * @module features/personal/voice/VoiceCallProvider
 */
import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { JSX, ReactNode } from "react";
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { type EnvironmentId, ThreadId } from "@t3tools/contracts";

import { createCallAudioContext } from "./callAudioContext";
import type { CallAudio, CallAudioPort } from "./callAudio";
import type { CreateLiveSocket } from "./liveClient";
import type { BotStatusPort, VoiceCallController, VoiceCallSnapshot } from "./voiceCallController";
import { type VoiceEndReason, type VoiceCallState, INITIAL_VOICE_CALL_STATE } from "./callState";
import { VOICE_UNDO_MS, endReasonLine } from "./callState";
import type { VoiceCallSession, VoiceCallTranscriptEntry } from "./voiceCallApi";
import {
  type VoiceCallStatusWatch,
  botStatusFromSnapshot,
  createVoiceCallStatusWatch,
  observeCallTurn,
} from "./voiceCallStatus";

/** One call, in the shell. */
export interface ActiveVoiceCall {
  readonly threadId: string;
  readonly botId: string;
  readonly botName: string;
  readonly avatarShape: string;
  readonly avatarColor: string;
  readonly startedAtMs: number;
  readonly minimised: boolean;
}

/** One call that has ended, ready to be the chat's call card. */
export interface FinishedVoiceCall {
  readonly threadId: string;
  readonly botId: string;
  readonly botName: string;
  readonly callId: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  /** "You hung up.", from the store's own reason copy. */
  readonly endedLine: string;
  readonly sentCount: number;
  readonly transcript: ReadonlyArray<VoiceCallTranscriptEntry>;
  readonly voiceName: string | null;
}

/** What the whole app reads from the one call. */
export interface VoiceCallContextValue {
  /** The call in progress, or null. Changes only when a call starts or ends. */
  readonly call: ActiveVoiceCall | null;
  readonly captionsOn: boolean;
  /**
   * True when the browser refused the screen wake lock: the screen may sleep
   * mid-call, which the call screen says plainly instead of pretending.
   */
  readonly wakeLockBlocked: boolean;
  /** Opens a call for one chat. Safe to call from a tap handler. */
  start: (input: {
    readonly threadId: string;
    readonly botId: string;
    readonly botName: string;
    readonly avatarShape: string;
    readonly avatarColor: string;
  }) => Promise<void>;
  end: (reason?: VoiceEndReason) => void;
  toggleMute: () => void;
  setCaptionsOn: (on: boolean) => void;
  setMinimised: (minimised: boolean) => void;
  undoSend: () => void;
  /** Reads the live level for the ring; never causes a render. */
  readLevel: () => number;
  /** Called by a chat screen with its own bot-status source for one thread. */
  registerBotStatus: (threadId: string, source: () => BotStatusPort) => () => void;
  /** A chat screen reports that the bot's turn ended on its own thread. */
  notifyBotTurnEnded: () => void;
  /** The newest snapshot, read on demand. */
  snapshot: () => VoiceCallSnapshot;
  /** The session behind the call, for the transcript footer and the limit line. */
  session: () => VoiceCallSession | null;
  /** The call cards this session has finished, newest last. */
  readonly finished: ReadonlyArray<FinishedVoiceCall>;
  /** Subscribes to the coalesced snapshot stream (the screen and the bar). */
  subscribe: (listener: () => void) => () => void;
}

const EMPTY_SNAPSHOT: VoiceCallSnapshot = {
  state: INITIAL_VOICE_CALL_STATE,
  elapsedMs: 0,
  transcript: [],
  sentMessageIds: [],
  botName: "",
  quietMinutes: 2,
  maxCallMinutes: 30,
  errorDetail: null,
};

const VoiceCallContext = createContext<VoiceCallContextValue | null>(null);

/** About ten captions a second: enough to read, cheap on a phone. */
const SNAPSHOT_FLUSH_MS = 100;

/** How often the shell looks at the call's own chat while a call is on. */
const CALL_WATCH_MS = 1_000;

/**
 * The call layer, lazy on purpose. It is only mounted while a call exists, so
 * its chunk is never fetched on an ordinary shell render (review finding: idle
 * cost on normal chats).
 */
const VoiceCallLayer = lazy(() =>
  import("./VoiceCallLayer").then((module) => ({ default: module.VoiceCallLayer })),
);

/** Renders the call UI only while there is a call. Costs nothing when idle. */
export function VoiceCallMount(): JSX.Element | null {
  const voice = useVoiceCall();
  if (voice === null || voice.call === null) return null;
  return (
    <Suspense fallback={null}>
      <VoiceCallLayer />
    </Suspense>
  );
}

/**
 * Preload the engine as soon as a finger lands on the call button, so the tap
 * itself is not the first thing to wait for a chunk.
 */
export function preloadVoiceCall(): void {
  void import("./voiceCallController");
  void import("./callAudio");
  void import("./voiceCallApi");
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
  readonly released: boolean;
}

/** The Screen Wake Lock API, when the browser has one. */
function requestScreenWakeLock(): Promise<WakeLockSentinelLike> | null {
  const api = (
    navigator as unknown as {
      wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
    }
  ).wakeLock;
  if (api === undefined) return null;
  try {
    return api.request("screen");
  } catch {
    return null;
  }
}

export function VoiceCallProvider({
  children,
  environmentId,
  createSocket,
}: {
  readonly children: ReactNode;
  /** The paired laptop the call's own commands go to. */
  readonly environmentId: EnvironmentId | null;
  /** Test seam: a fake Live socket. */
  readonly createSocket?: CreateLiveSocket;
}): JSX.Element {
  const registry = useContext(RegistryContext);
  const [call, setCall] = useState<ActiveVoiceCall | null>(null);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [wakeLockBlocked, setWakeLockBlocked] = useState(false);
  const [finished, setFinished] = useState<ReadonlyArray<FinishedVoiceCall>>([]);
  const engineRef = useRef<VoiceCallController | null>(null);
  /** Reserved synchronously on the tap: two taps are one call. */
  const startingRef = useRef(false);
  /** The shell-side record of the open call, read when it ends. */
  const activeRef = useRef<ActiveVoiceCall | null>(null);
  const audioRef = useRef<CallAudio | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  /**
   * One bot-status source per thread, registered by whichever chat screens are
   * mounted. The call reads only its own thread's, and keeps the last answer it
   * got when that screen goes away.
   */
  const statusWatchRef = useRef<VoiceCallStatusWatch | null>(null);
  statusWatchRef.current ??= createVoiceCallStatusWatch();
  const statusWatch = statusWatchRef.current;
  /** The last snapshot the server gave for this call's own chat. */
  const serverStatusRef = useRef<{ callId: string; status: BotStatusPort } | null>(null);
  /** The loaded voiceCallApi module, kept for the snapshot poll. */
  const voiceApiRef = useRef<typeof import("./voiceCallApi") | null>(null);
  const workingRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);

  // The coalesced snapshot store. Only the call UI subscribes.
  const storeRef = useRef<{
    snapshot: VoiceCallSnapshot;
    listeners: Set<() => void>;
    timer: ReturnType<typeof setTimeout> | null;
    dirty: boolean;
  }>({ snapshot: EMPTY_SNAPSHOT, listeners: new Set(), timer: null, dirty: false });

  const flush = useCallback(() => {
    const store = storeRef.current;
    store.timer = null;
    if (!store.dirty) return;
    store.dirty = false;
    for (const listener of store.listeners) listener();
  }, []);

  const publish = useCallback(
    (next: VoiceCallSnapshot) => {
      const store = storeRef.current;
      store.snapshot = next;
      store.dirty = true;
      store.timer ??= setTimeout(flush, SNAPSHOT_FLUSH_MS);
    },
    [flush],
  );

  const subscribe = useCallback((listener: () => void) => {
    const store = storeRef.current;
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
    };
  }, []);

  /**
   * The bot's real state for the CALL's thread, from the server's own snapshot
   * of that chat. It never falls back to `idle` just because the chat is not on
   * screen: before the first snapshot, and if the server cannot be asked at
   * all, the last answer stands. That is what stops a navigation being read as
   * "the bot finished its turn".
   */
  const readBotStatus = useCallback((): BotStatusPort => {
    const server = serverStatusRef.current;
    if (server !== null && server.callId === engineRef.current?.session?.callId) {
      return server.status;
    }
    return statusWatch.read(activeRef.current?.threadId ?? null);
  }, [statusWatch]);

  const releaseWakeLock = useCallback(() => {
    const sentinel = wakeLockRef.current;
    wakeLockRef.current = null;
    if (sentinel === null) return;
    void sentinel.release().catch(() => undefined);
  }, []);

  /**
   * One server read of the call's OWN chat. Called only while the voice is
   * waiting on the bot, or right after the voice asks a question: it is one
   * small indexed read, not a loop that runs for the whole call.
   */
  const refreshCallSnapshot = useCallback(async (): Promise<void> => {
    const engine = engineRef.current;
    const voiceApi = voiceApiRef.current;
    const callId = engine?.session?.callId ?? null;
    const threadId = activeRef.current?.threadId ?? null;
    if (
      engine === null ||
      voiceApi === null ||
      callId === null ||
      threadId === null ||
      environmentId === null ||
      engine.ended
    ) {
      return;
    }
    const result = await runAtomCommand(
      registry,
      voiceApi.personalVoiceCallSnapshot,
      { environmentId, input: { threadId: ThreadId.make(threadId), callId } },
      { reportFailure: false, reportDefect: false },
    );
    // A newer call has taken over while this one was in flight.
    if (engineRef.current !== engine) return;
    if (result._tag !== "Success") {
      // `not_found` means the server no longer holds this call: the laptop
      // restarted and its lease is gone. The call ends cleanly, nothing retried.
      if (voiceApi.voiceCallFailureCode(result) === "not_found") engine.callLost();
      return;
    }
    serverStatusRef.current = { callId, status: botStatusFromSnapshot(result.value) };
  }, [environmentId, registry]);

  const end = useCallback(
    (reason: VoiceEndReason = "hung_up") => {
      const engine = engineRef.current;
      const ended = engine?.snapshot() ?? null;
      const callInfo = activeRef.current;
      engine?.end(reason);
      if (engine !== null && ended !== null && callInfo !== null && engine.session !== null) {
        const session = engine.session;
        setFinished((previous) => [
          ...previous,
          {
            threadId: callInfo.threadId,
            botId: callInfo.botId,
            botName: callInfo.botName,
            callId: session.callId,
            startedAtMs: callInfo.startedAtMs,
            durationMs: ended.elapsedMs,
            endedLine: endReasonLine(reason, ended.quietMinutes),
            sentCount: ended.sentMessageIds.length,
            transcript: ended.transcript,
            voiceName: session.voiceName,
          },
        ]);
      }
      engine?.dispose();
      engineRef.current = null;
      audioRef.current = null;
      contextRef.current = null;
      activeRef.current = null;
      startingRef.current = false;
      workingRef.current = false;
      statusWatch.reset();
      serverStatusRef.current = null;
      voiceApiRef.current = null;
      releaseWakeLock();
      setWakeLockBlocked(false);
      storeRef.current.snapshot = EMPTY_SNAPSHOT;
      setCall(null);
    },
    [releaseWakeLock],
  );

  const start = useCallback<VoiceCallContextValue["start"]>(
    async (input) => {
      // The slot is taken before the first await, so a double tap cannot mint
      // two passes (review finding 4).
      if (engineRef.current !== null || startingRef.current) return;
      startingRef.current = true;
      // iOS: the context must be made here, in the tap, before anything awaits.
      if (contextRef.current === null) {
        contextRef.current = createCallAudioContext();
      }
      const context = contextRef.current;
      if (context !== null && context.state !== "running") {
        void context.resume().catch(() => undefined);
      }
      const startedAtMs = Date.now();
      const active: ActiveVoiceCall = { ...input, startedAtMs, minimised: false };
      activeRef.current = active;
      setCall(active);

      let voiceApi: typeof import("./voiceCallApi");
      try {
        voiceApi = await import("./voiceCallApi");
      } catch {
        startingRef.current = false;
        activeRef.current = null;
        setCall(null);
        return;
      }
      if (!startingRef.current) return;
      // Kept for the call's own status poll: the snapshot RPC is the only thing
      // the voice reads the bot from.
      voiceApiRef.current = voiceApi;
      const [{ createCallAudio }, { createVoiceCallController }] = await Promise.all([
        import("./callAudio"),
        import("./voiceCallController"),
      ]);
      if (!startingRef.current) return;

      const audio = createCallAudio({
        context,
        onFrame: (pcm) => engineRef.current?.sendAudio(pcm),
      });
      audioRef.current = audio;
      /** Every server call: silent on failure, the engine renders the code. */
      const commandOptions = { reportFailure: false, reportDefect: false } as const;
      const offline = {
        ok: false as const,
        code: "google_unavailable" as const,
        detail: "No laptop is connected.",
      };
      const engine = createVoiceCallController({
        threadId: input.threadId,
        botName: input.botName,
        api: {
          start: async (threadId) => {
            if (environmentId === null) return offline;
            const result = await runAtomCommand(
              registry,
              voiceApi.personalVoiceCallStart,
              { environmentId, input: { threadId: ThreadId.make(threadId) } },
              commandOptions,
            );
            return result._tag === "Success"
              ? { ok: true, value: result.value }
              : {
                  ok: false,
                  code: voiceApi.voiceCallFailureCode(result),
                  detail: voiceApi.voiceFailureDetail(result),
                };
          },
          send: async (sendInput) => {
            if (environmentId === null) return offline;
            const result = await runAtomCommand(
              registry,
              voiceApi.personalVoiceCallSend,
              {
                environmentId,
                input: {
                  threadId: ThreadId.make(sendInput.threadId),
                  callId: sendInput.callId,
                  text: sendInput.text,
                },
              },
              commandOptions,
            );
            return result._tag === "Success"
              ? { ok: true, value: { messageId: result.value.messageId } }
              : {
                  ok: false,
                  code: voiceApi.voiceCallFailureCode(result),
                  detail: voiceApi.voiceFailureDetail(result),
                };
          },
          lookupMemory: async (memoryInput) => {
            if (environmentId === null) return offline;
            const result = await runAtomCommand(
              registry,
              voiceApi.personalVoiceCallLookupMemory,
              {
                environmentId,
                input: {
                  threadId: ThreadId.make(memoryInput.threadId),
                  callId: memoryInput.callId,
                  query: memoryInput.query,
                },
              },
              commandOptions,
            );
            return result._tag === "Success"
              ? { ok: true, value: result.value }
              : {
                  ok: false,
                  code: voiceApi.voiceCallFailureCode(result),
                  detail: voiceApi.voiceFailureDetail(result),
                };
          },
          renewPass: async (renewInput) => {
            if (environmentId === null) return offline;
            const result = await runAtomCommand(
              registry,
              voiceApi.personalVoiceCallRenewPass,
              {
                environmentId,
                input: {
                  threadId: ThreadId.make(renewInput.threadId),
                  callId: renewInput.callId,
                  reason: renewInput.reason,
                },
              },
              commandOptions,
            );
            return result._tag === "Success"
              ? { ok: true, value: result.value }
              : {
                  ok: false,
                  code: voiceApi.voiceCallFailureCode(result),
                  detail: voiceApi.voiceFailureDetail(result),
                };
          },
          searchWeb: async (searchInput) => {
            if (environmentId === null) return offline;
            const result = await runAtomCommand(
              registry,
              voiceApi.personalVoiceCallSearchWeb,
              {
                environmentId,
                input: {
                  threadId: ThreadId.make(searchInput.threadId),
                  callId: searchInput.callId,
                  query: searchInput.query,
                },
              },
              commandOptions,
            );
            return result._tag === "Success"
              ? { ok: true, value: result.value }
              : {
                  ok: false,
                  code: voiceApi.voiceCallFailureCode(result),
                  detail: voiceApi.voiceFailureDetail(result),
                };
          },
          finish: async (finishInput) => {
            if (environmentId === null) return offline;
            const result = await runAtomCommand(
              registry,
              voiceApi.personalVoiceCallFinish,
              {
                environmentId,
                input: {
                  ...finishInput,
                  threadId: ThreadId.make(finishInput.threadId),
                },
              },
              commandOptions,
            );
            return result._tag === "Success"
              ? { ok: true, value: { ok: true } }
              : {
                  ok: false,
                  code: voiceApi.voiceCallFailureCode(result),
                  detail: voiceApi.voiceFailureDetail(result),
                };
          },
        },
        audio,
        botStatus: readBotStatus,
        refreshBotStatus: refreshCallSnapshot,
        onChange: publish,
        ...(createSocket === undefined ? {} : { createSocket }),
      });
      engineRef.current = engine;
      await engine.start();
    },
    [createSocket, environmentId, publish, readBotStatus, registry],
  );

  // Leaving the app or locking the phone ends the call: iOS stops the mic and
  // the audio anyway, so the call is flushed with keepalive rather than left
  // hanging on the server. Coming back re-takes the wake lock and retries a card
  // the server has not acknowledged.
  useEffect(() => {
    if (call === null) return;
    let wakeLock: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const request = () => {
      if (cancelled) return;
      const pending = requestScreenWakeLock();
      if (pending === null) {
        setWakeLockBlocked(true);
        return;
      }
      void pending
        .then((sentinel) => {
          if (cancelled) {
            void sentinel.release().catch(() => undefined);
            return;
          }
          wakeLock = sentinel;
          wakeLockRef.current = sentinel;
          setWakeLockBlocked(false);
        })
        .catch(() => {
          if (!cancelled) setWakeLockBlocked(true);
        });
    };

    request();

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        end("left_app");
        return;
      }
      // Back in the foreground: the lock the OS dropped must be taken again,
      // and a card that never reached the server gets another try.
      request();
      engineRef.current?.retryFinish();
    };
    const onPageHide = () => {
      if (document.visibilityState === "hidden") end("left_app");
    };
    const onOnline = () => engineRef.current?.retryFinish();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      if (wakeLock !== null) void wakeLock.release().catch(() => undefined);
      if (wakeLockRef.current === wakeLock) wakeLockRef.current = null;
    };
  }, [call, end]);

  // The screen is the only thing that knows about time passing, so the timer
  // lives in the store: no interval in the shell, and nothing at all while idle.
  //
  // Each tick asks the server for the CALL's own chat before it decides
  // anything, so the voice reads the bot's real state and its real reply
  // whatever chat happens to be on screen (review finding 6).
  useEffect(() => {
    if (call === null) return;
    let cancelled = false;

    const interval = setInterval(() => {
      const engine = engineRef.current;
      if (engine === null) return;
      if (!engine.watchBot) {
        // Nothing is waiting on the bot: the timer still ticks for the screen,
        // but the server is not asked at all.
        publish(engine.snapshot());
        return;
      }
      void refreshCallSnapshot().then(() => {
        if (cancelled) return;
        const live = engineRef.current;
        if (live !== engine) return;
        const next = engine.snapshot();
        publish(next);
        // The turn end is read from the CALL's own chat. A screen going away
        // changes nothing: with neither source the last answer is held.
        const turn = observeCallTurn({
          watching: serverStatusRef.current !== null || statusWatch.hasSource(call.threadId),
          live: next.state.status === "live",
          status: readBotStatus(),
          wasWorking: workingRef.current,
        });
        if (turn.ended) engine.botTurnEnded();
        workingRef.current = turn.working;
      });
    }, CALL_WATCH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [call, publish, readBotStatus, refreshCallSnapshot, statusWatch]);

  // Unmounting the shell is the end of the call: the socket, the microphone and
  // the audio all go, and the card is still handed to the server first.
  useEffect(
    () => () => {
      const engine = engineRef.current;
      engine?.end("hung_up");
      engine?.dispose();
      engineRef.current = null;
      audioRef.current = null;
      contextRef.current = null;
      activeRef.current = null;
      startingRef.current = false;
      serverStatusRef.current = null;
      voiceApiRef.current = null;
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      if (sentinel !== null) void sentinel.release().catch(() => undefined);
    },
    [],
  );

  const value = useMemo<VoiceCallContextValue>(
    () => ({
      call,
      captionsOn,
      wakeLockBlocked,
      start,
      end,
      toggleMute: () => {
        const engine = engineRef.current;
        if (engine === null) return;
        engine.setMuted(!engine.snapshot().state.muted);
      },
      setCaptionsOn,
      setMinimised: (minimised: boolean) => {
        if (activeRef.current !== null) activeRef.current = { ...activeRef.current, minimised };
        setCall((current) => (current === null ? null : { ...current, minimised }));
      },
      undoSend: () => engineRef.current?.undoPendingSend(),
      readLevel: () => engineRef.current?.readLevel() ?? 0,
      registerBotStatus: (threadId: string, source: () => BotStatusPort) =>
        statusWatch.register(threadId, source),
      notifyBotTurnEnded: () => engineRef.current?.botTurnEnded(),
      snapshot: () => storeRef.current.snapshot,
      session: () => engineRef.current?.session ?? null,
      finished,
      subscribe,
    }),
    [call, captionsOn, end, finished, start, subscribe, wakeLockBlocked],
  );

  return <VoiceCallContext.Provider value={value}>{children}</VoiceCallContext.Provider>;
}

/** The call, from any screen. A screen outside a provider simply has no call. */
export function useVoiceCall(): VoiceCallContextValue | null {
  return useContext(VoiceCallContext);
}

/** The call's live state, coalesced: only the call UI subscribes to this. */
export function useVoiceCallSnapshot(): VoiceCallSnapshot {
  const context = useContext(VoiceCallContext);
  const subscribe = context?.subscribe ?? (() => () => undefined);
  const snapshot = context?.snapshot ?? (() => EMPTY_SNAPSHOT);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The call's undo window, exposed for the composer's own copy. */
export const VOICE_UNDO_WINDOW_MS = VOICE_UNDO_MS;

export type { VoiceCallState, VoiceCallSession, VoiceCallTranscriptEntry };
