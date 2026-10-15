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
 * High-frequency state (captions, the ring's level, the timer) never
 * re-renders the app: the snapshot lives in a small external store that only
 * the call screen and the bar subscribe to, coalesced to about ten updates a
 * second.
 *
 * @module features/personal/voice/VoiceCallProvider
 */
import type { JSX, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomCommand } from "~/state/use-atom-command";

import type { CallAudio, CallAudioPort } from "./callAudio";
import type { CreateLiveSocket } from "./liveClient";
import type { BotStatusPort, VoiceCallController, VoiceCallSnapshot } from "./voiceCallController";
import { type VoiceEndReason, type VoiceCallState, INITIAL_VOICE_CALL_STATE } from "./callState";
import { VOICE_UNDO_MS, endReasonLine } from "./callState";
import {
  type VoiceCallSession,
  type VoiceCallTranscriptEntry,
  personalVoiceCallFinish,
  personalVoiceCallSend,
  personalVoiceCallStart,
  voiceCallFailureCode,
  voiceFailureDetail,
} from "./voiceCallApi";

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
  /** Called by a chat screen with its own bot-status source for the open call. */
  registerBotStatus: (threadId: string, source: () => BotStatusPort) => () => void;
  /** A chat screen reports that the bot's turn ended. */
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

/**
 * Preload the engine as soon as a finger lands on the call button, so the tap
 * itself is not the first thing to wait for a chunk.
 */
export function preloadVoiceCall(): void {
  void import("./voiceCallController");
  void import("./callAudio");
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
  const startCall = useAtomCommand(personalVoiceCallStart, { reportFailure: false });
  const sendToBot = useAtomCommand(personalVoiceCallSend, { reportFailure: false });
  const finishCall = useAtomCommand(personalVoiceCallFinish, { reportFailure: false });
  const [call, setCall] = useState<ActiveVoiceCall | null>(null);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [finished, setFinished] = useState<ReadonlyArray<FinishedVoiceCall>>([]);
  const engineRef = useRef<VoiceCallController | null>(null);
  /** The shell-side record of the open call, read when it ends. */
  const activeRef = useRef<ActiveVoiceCall | null>(null);
  const audioRef = useRef<CallAudio | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const statusSourceRef = useRef<{ threadId: string; source: () => BotStatusPort } | null>(null);
  const workingRef = useRef(false);

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

  /** The offline bot-status fallback: a call without a chat screen still works. */
  const fallbackStatus = useCallback((): BotStatusPort => {
    const source = statusSourceRef.current;
    return source === null
      ? { state: "idle", step: null, elapsedMs: null, latestReply: null }
      : source.source();
  }, []);

  const end = useCallback((reason: VoiceEndReason = "hung_up") => {
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
    statusSourceRef.current = null;
    activeRef.current = null;
    workingRef.current = false;
    storeRef.current.snapshot = EMPTY_SNAPSHOT;
    setCall(null);
  }, []);

  const start = useCallback<VoiceCallContextValue["start"]>(
    async (input) => {
      if (engineRef.current !== null) return;
      // iOS: the context must be made here, in the tap, before anything awaits.
      if (contextRef.current === null) {
        const { createCallAudioContext } = await import("./callAudio");
        contextRef.current = createCallAudioContext();
      }
      const context = contextRef.current;
      if (context !== null && context.state !== "running") {
        void context.resume().catch(() => undefined);
      }
      setCall({
        threadId: input.threadId,
        botId: input.botId,
        botName: input.botName,
        avatarShape: input.avatarShape,
        avatarColor: input.avatarColor,
        startedAtMs: Date.now(),
        minimised: false,
      });
      activeRef.current = {
        threadId: input.threadId,
        botId: input.botId,
        botName: input.botName,
        avatarShape: input.avatarShape,
        avatarColor: input.avatarColor,
        startedAtMs: Date.now(),
        minimised: false,
      };

      const [{ createCallAudio }, { createVoiceCallController }] = await Promise.all([
        import("./callAudio"),
        import("./voiceCallController"),
      ]);

      const audio = createCallAudio({
        context,
        onFrame: (pcm) => engineRef.current?.sendAudio(pcm),
      });
      audioRef.current = audio;
      const engine = createVoiceCallController({
        threadId: input.threadId,
        botName: input.botName,
        api: {
          start: async (threadId) => {
            if (environmentId === null) {
              return { ok: false, code: "google_unavailable", detail: "No laptop is connected." };
            }
            const result = await startCall({
              environmentId,
              input: { threadId: ThreadId.make(threadId) },
            });
            return result._tag === "Success"
              ? { ok: true, value: result.value }
              : {
                  ok: false,
                  code: voiceCallFailureCode(result),
                  detail: voiceFailureDetail(result),
                };
          },
          send: async (sendInput) => {
            if (environmentId === null) {
              return { ok: false, code: "google_unavailable", detail: "No laptop is connected." };
            }
            const result = await sendToBot({
              environmentId,
              input: {
                threadId: ThreadId.make(sendInput.threadId),
                callId: sendInput.callId,
                text: sendInput.text,
              },
            });
            return result._tag === "Success"
              ? { ok: true, value: { messageId: result.value.messageId } }
              : {
                  ok: false,
                  code: voiceCallFailureCode(result),
                  detail: voiceFailureDetail(result),
                };
          },
          finish: async (finishInput) => {
            if (environmentId === null) {
              return { ok: false, code: "google_unavailable", detail: "No laptop is connected." };
            }
            const result = await finishCall({
              environmentId,
              input: {
                ...finishInput,
                threadId: ThreadId.make(finishInput.threadId),
              },
            });
            return result._tag === "Success"
              ? { ok: true, value: { ok: true } }
              : {
                  ok: false,
                  code: voiceCallFailureCode(result),
                  detail: voiceFailureDetail(result),
                };
          },
        },
        audio,
        botStatus: fallbackStatus,
        onChange: publish,
        ...(createSocket === undefined ? {} : { createSocket }),
      });
      engineRef.current = engine;
      await engine.start();
    },
    [createSocket, environmentId, fallbackStatus, finishCall, publish, sendToBot, startCall],
  );

  // Leaving the app or locking the phone ends the call: iOS stops the mic and
  // the audio anyway, so the call is flushed with keepalive rather than left
  // hanging on the server.
  useEffect(() => {
    if (call === null) return;
    const onHidden = () => {
      if (document.visibilityState === "hidden") end("left_app");
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onHidden);
    };
  }, [call, end]);

  // The screen is the only thing that knows about time passing, so the timer
  // lives in the store: no interval in the shell, and nothing at all while idle.
  useEffect(() => {
    if (call === null) return;
    const interval = setInterval(() => {
      const engine = engineRef.current;
      if (engine === null) return;
      const next = engine.snapshot();
      publish(next);
      const working = next.state.status === "live" && fallbackStatus().state === "working";
      if (workingRef.current && !working) engine.botTurnEnded();
      workingRef.current = working;
    }, 1_000);
    return () => clearInterval(interval);
  }, [call, fallbackStatus, publish]);

  useEffect(
    () => () => {
      engineRef.current?.dispose();
    },
    [],
  );

  const value = useMemo<VoiceCallContextValue>(
    () => ({
      call,
      captionsOn,
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
      registerBotStatus: (threadId: string, source: () => BotStatusPort) => {
        statusSourceRef.current = { threadId, source };
        return () => {
          if (statusSourceRef.current?.source === source) statusSourceRef.current = null;
        };
      },
      notifyBotTurnEnded: () => engineRef.current?.botTurnEnded(),
      snapshot: () => storeRef.current.snapshot,
      session: () => engineRef.current?.session ?? null,
      finished,
      subscribe,
    }),
    [call, captionsOn, end, finished, start, subscribe],
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
