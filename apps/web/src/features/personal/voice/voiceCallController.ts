/**
 * The call engine: it owns the session, the socket, the timers and every rule
 * that ends a call. The React provider is a thin wrapper around it and the
 * screen is a renderer, so the whole call can be driven by a fake socket and a
 * fake API in a test.
 *
 * Rules that come straight from the brief and the spec:
 * - `send_to_bot` is non-blocking: the Undo card holds the message for 3
 *   seconds, then it posts as the owner's own message; the tool call itself is
 *   answered when the bot's turn ends, with scheduling WHEN_IDLE, so the voice
 *   reads the reply at a natural pause and never talks over him.
 * - Undo (or "no, wait") answers the tool call with `cancelled_by_user` and
 *   scheduling INTERRUPT; nothing is posted.
 * - A call that never connected leaves nothing in the chat.
 * - `finish()` runs exactly once per call, whatever ended it.
 * - A user tapping Stop is not an error: it ends as `hung_up`, never as a drop.
 *
 * @module features/personal/voice/voiceCallController
 */
import type { CallAudioPort } from "./callAudio";
import type { CreateLiveSocket, LiveClient, LiveToolCall } from "./liveClient";
import { connectLive } from "./liveClient";
import { MessageId, ThreadId, VoiceCallTranscriptEntry } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const decodeThreadId = Schema.decodeUnknownSync(ThreadId);
const decodeMessageId = Schema.decodeUnknownSync(MessageId);
const decodeTranscriptEntry = Schema.decodeUnknownSync(VoiceCallTranscriptEntry);

import type { VoiceCallErrorCode, VoiceCallFinishInput, VoiceCallSession } from "./voiceCallApi";
import {
  INITIAL_VOICE_CALL_STATE,
  VOICE_RECONNECT_GIVE_UP_MS,
  VOICE_RECONNECT_HIDDEN_MS,
  VOICE_UNDO_MS,
  VOICE_WAITING_CAP_MS,
  type VoiceCallState,
  type VoiceEndReason,
  type VoiceWorkCard,
  callHint,
  endReasonLine,
  limitPointsMs,
  quietDeadlineMs,
  quietExpired,
  quietWarningAtMs,
} from "./callState";

/**
 * One server answer, as the engine reads it. The provider maps the RPC's own
 * result onto this, so the engine never knows a transport exists.
 */
export type VoiceApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: VoiceCallErrorCode; readonly detail: string };

/** The server calls the engine makes; a test supplies its own. */
export interface VoiceCallPort {
  start(threadId: string): Promise<VoiceApiResult<VoiceCallSession>>;
  send(input: {
    readonly threadId: string;
    readonly callId: string;
    readonly text: string;
  }): Promise<VoiceApiResult<{ readonly messageId: string }>>;
  finish(input: VoiceCallFinishInput): Promise<VoiceApiResult<{ readonly ok: boolean }>>;
  /**
   * The voice's own fast facts: the owner's saved notes, read out on the call.
   * Nothing is posted into the chat and there is no Undo card.
   */
  lookupMemory(input: {
    readonly threadId: string;
    readonly callId: string;
    readonly query: string;
  }): Promise<
    VoiceApiResult<{
      readonly entries: ReadonlyArray<{ readonly kind: string; readonly content: string }>;
      readonly note: string;
    }>
  >;
}

/** What the engine reads about the real bot, from the chat's own subscriptions. */
export interface BotStatusPort {
  /** "working", "idle", "needs_help", ... */
  readonly state: string;
  /** The chat's own current progress line, or null. */
  readonly step: string | null;
  /** How long the current turn has been running, ms, or null. */
  readonly elapsedMs: number | null;
  /** The bot's latest reply text in the chat, or null. */
  readonly latestReply: string | null;
}

export interface VoiceCallSnapshot {
  readonly state: VoiceCallState;
  readonly elapsedMs: number;
  readonly transcript: ReadonlyArray<VoiceCallTranscriptEntry>;
  /** Ids of the messages the voice posted, in order. */
  readonly sentMessageIds: ReadonlyArray<string>;
  readonly botName: string;
  readonly quietMinutes: number;
  readonly maxCallMinutes: number;
  readonly errorDetail: string | null;
}

export interface VoiceCallControllerOptions {
  readonly threadId: string;
  readonly botName: string;
  readonly api: VoiceCallPort;
  readonly audio: CallAudioPort;
  /** Live look at the real bot; the provider wires this to the chat's subscriptions. */
  readonly botStatus: () => BotStatusPort;
  readonly createSocket?: CreateLiveSocket;
  /** How long to wait for setupComplete before the endpoint is abandoned. */
  readonly setupTimeoutMs?: number;
  readonly now?: () => number;
  /** Every state change, already folded with the elapsed time and transcript. */
  readonly onChange: (snapshot: VoiceCallSnapshot) => void;
  /** Fired once a voice-sent message really posted. */
  readonly onSent?: (payload: { readonly messageId: string; readonly text: string }) => void;
}

export interface VoiceCallController {
  /** Opens the call. Resolves once the session exists (not once it is live). */
  start(): Promise<void>;
  /** One 16 kHz mono PCM frame from the microphone. */
  sendAudio(pcm: ArrayBuffer): void;
  /** The owner tapped Undo, or said "no, wait". */
  undoPendingSend(): void;
  /** The voice stopped talking: drop anything still queued. */
  interrupted(): void;
  /** Called by the provider when the bot's turn ends (WHEN_IDLE bookkeeping). */
  botTurnEnded(): void;
  /** Feed one transcribed line in, for the stored transcript. */
  noteTranscript(row: VoiceCallTranscriptEntry): void;
  /** Reads the live mic/voice level for the ring. Never a React render. */
  readLevel(): number;
  /** Mic on or off. The track is disabled, never stopped, so unmute is instant. */
  setMuted(muted: boolean): void;
  snapshot(): VoiceCallSnapshot;
  /** Ends the call, exactly once, through `finish()`. */
  end(reason: VoiceEndReason): void;
  /** Removes every listener and timer this call added. */
  dispose(): void;
  readonly session: VoiceCallSession | null;
  readonly ended: boolean;
}

/** A tool call whose answer is still owed: read at the end of the bot's turn. */
interface PendingToolAnswer {
  readonly id: string;
  readonly name: string;
  readonly response: Record<string, unknown>;
}

/** The send the Undo card is holding, with the tool call it belongs to. */
interface OpenSend {
  readonly text: string;
  readonly atMs: number;
  readonly toolCallId: string;
  cancelled: boolean;
}

export function createVoiceCallController(
  options: VoiceCallControllerOptions,
): VoiceCallController {
  const now = options.now ?? (() => Date.now());
  const startedAtMs = now();
  let state: VoiceCallState = { ...INITIAL_VOICE_CALL_STATE };
  let transcript: VoiceCallTranscriptEntry[] = [];
  const sentMessageIds: string[] = [];
  let session: VoiceCallSession | null = null;
  let live: LiveClient | null = null;
  let ended = false;
  let finished = false;
  let everConnected = false;
  let errorDetail: string | null = null;
  let lastSpeechAtMs = startedAtMs;
  let quietWarned = false;
  let limitWarned = false;
  let waitingSinceMs: number | null = null;
  let reconnectSinceMs: number | null = null;
  let micStarted = false;
  let openSend: OpenSend | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  const pendingAnswers: PendingToolAnswer[] = [];

  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timeouts.delete(timer);
      fn();
    }, ms);
    timeouts.add(timer);
    return timer;
  };

  const quietMinutes = () => session?.quietHangupMinutes ?? 2;
  const maxCallMinutes = () => session?.maxCallMinutes ?? 30;
  const elapsedMs = () => Math.max(0, now() - startedAtMs);

  const snapshot = (): VoiceCallSnapshot => ({
    state,
    elapsedMs: elapsedMs(),
    transcript,
    sentMessageIds: [...sentMessageIds],
    botName: session?.botName ?? options.botName,
    quietMinutes: quietMinutes(),
    maxCallMinutes: maxCallMinutes(),
    errorDetail,
  });

  const publish = (patch: Partial<VoiceCallState>) => {
    state = { ...state, ...patch };
    options.onChange(snapshot());
  };

  const noteTranscript = (row: VoiceCallTranscriptEntry) => {
    transcript = [...transcript, row];
  };

  /**
   * One call card per call, with the reason, whatever ended it. A call that
   * never connected leaves nothing in the chat, so nothing is stored for it.
   */
  const finish = (reason: VoiceEndReason) => {
    if (finished || session === null || !everConnected) return;
    finished = true;
    void options.api.finish({
      threadId: decodeThreadId(options.threadId),
      callId: session.callId,
      startedAt: DateTime.makeUnsafe(startedAtMs),
      endedAt: DateTime.makeUnsafe(now()),
      endReason: reason,
      transcript,
      sentMessageIds: sentMessageIds.map((id) => decodeMessageId(id)),
      ...(errorDetail === null ? {} : { detail: errorDetail.slice(0, 400) }),
    });
  };

  const end = (reason: VoiceEndReason) => {
    if (ended) return;
    ended = true;
    if (tick !== null) clearInterval(tick);
    tick = null;
    try {
      live?.stop();
    } catch {
      // Already closed.
    }
    live = null;
    if (micStarted) {
      try {
        options.audio.close();
      } catch {
        // Nothing left to close.
      }
      micStarted = false;
    }
    pendingAnswers.length = 0;
    openSend = null;
    if (reason !== "failed") {
      try {
        options.audio.cue("ended");
        options.audio.stopPlayback();
      } catch {
        // Audio is already down; the call still ends.
      }
    }
    finish(reason);
    publish({
      status: everConnected ? "ended" : "error",
      pill: "none",
      endReason: reason,
      hint: endReasonLine(reason, quietMinutes()),
      pending: null,
      work: null,
    });
  };

  const workFor = (): VoiceWorkCard | null => {
    if (openSend !== null && !openSend.cancelled) {
      return { kind: "sending", title: "", detail: openSend.text, sinceMs: openSend.atMs };
    }
    const status = options.botStatus();
    if (status.state === "working") {
      return { kind: "working", title: "", detail: status.step ?? "", sinceMs: null };
    }
    if (status.latestReply !== null && status.latestReply.length > 0) {
      return { kind: "replied", title: "", detail: status.latestReply, sinceMs: null };
    }
    return null;
  };

  /** The message the voice sent really posts as the owner's own message. */
  const postSend = async (send: OpenSend) => {
    if (session === null) return;
    const result = await options.api.send({
      threadId: options.threadId,
      callId: session.callId,
      text: send.text,
    });
    if (result.ok) {
      sentMessageIds.push(result.value.messageId);
      options.onSent?.({ messageId: result.value.messageId, text: send.text });
      // The card in the chat counts what went, so the snapshot has to catch up.
      publish({});
      return;
    }
    errorDetail = result.detail;
    publish({});
  };

  const answerTool = (
    id: string,
    name: string,
    response: Record<string, unknown>,
    scheduling: "INTERRUPT" | "WHEN_IDLE" | "SILENT",
  ) => {
    try {
      live?.respondToTool({ id, name, response, scheduling });
    } catch {
      // A dead socket: the call is ending anyway.
    }
  };

  const answerOwedToolCalls = (scheduling: "INTERRUPT" | "WHEN_IDLE" | "SILENT") => {
    for (const answer of pendingAnswers.splice(0, pendingAnswers.length)) {
      answerTool(answer.id, answer.name, answer.response, scheduling);
    }
  };

  const onToolCall = (call: LiveToolCall) => {
    lastSpeechAtMs = now();
    switch (call.name) {
      case "lookup_memory": {
        // Fast and invisible: the pill says what is happening, nothing is
        // posted, and the voice gets the entries to say out loud.
        const query = typeof call.args.query === "string" ? call.args.query.trim() : "";
        const callId = session?.callId ?? "";
        publish({ pill: "checking_memory" });
        void options.api
          .lookupMemory({ threadId: options.threadId, callId, query })
          .then((result) => {
            if (ended) return;
            answerTool(
              call.id,
              call.name,
              result.ok
                ? {
                    entries: result.value.entries.slice(0, 8),
                    ...(result.value.note.length > 0 ? { note: result.value.note } : {}),
                  }
                : { entries: [], note: "Memory could not be read just now." },
              "INTERRUPT",
            );
            publish({ pill: state.muted ? "muted" : "listening" });
          })
          .catch(() => {
            if (ended) return;
            answerTool(
              call.id,
              call.name,
              { entries: [], note: "Memory could not be read just now." },
              "INTERRUPT",
            );
            publish({ pill: state.muted ? "muted" : "listening" });
          });
        return;
      }
      case "send_to_bot": {
        const text = typeof call.args.text === "string" ? call.args.text.trim() : "";
        if (text.length === 0) {
          answerTool(call.id, call.name, { ok: false, reason: "empty" }, "INTERRUPT");
          return;
        }
        // A second send while one is held posts the first straight away.
        const previous = openSend;
        if (previous !== null && !previous.cancelled) {
          pendingAnswers.push({
            id: previous.toolCallId,
            name: "send_to_bot",
            response: { ok: true, status: "sent" },
          });
          void postSend(previous);
        }
        const atMs = now();
        openSend = { text, atMs, toolCallId: call.id, cancelled: false };
        publish({
          pending: { text, atMs, dueAtMs: atMs + VOICE_UNDO_MS, cancelled: false },
          work: { kind: "sending", title: "", detail: text, sinceMs: atMs },
        });
        later(() => {
          const send = openSend;
          if (send === null || send.cancelled || send.toolCallId !== call.id) return;
          openSend = null;
          publish({ pending: null, work: workFor() });
          void postSend(send);
          pendingAnswers.push({
            id: call.id,
            name: call.name,
            response: { ok: true, status: "sent" },
          });
          // With no bot turn running there is no end to wait for: read it now.
          if (options.botStatus().state !== "working") {
            answerOwedToolCalls("WHEN_IDLE");
          } else {
            waitingSinceMs = now();
          }
        }, VOICE_UNDO_MS);
        return;
      }
      case "bot_status": {
        const status = options.botStatus();
        answerTool(
          call.id,
          call.name,
          {
            state: status.state,
            step: status.step,
            elapsedSeconds: status.elapsedMs === null ? null : Math.round(status.elapsedMs / 1_000),
          },
          "INTERRUPT",
        );
        return;
      }
      case "latest_reply": {
        answerTool(
          call.id,
          call.name,
          { reply: options.botStatus().latestReply ?? "" },
          "INTERRUPT",
        );
        return;
      }
      case "end_call": {
        answerTool(call.id, call.name, { ok: true }, "WHEN_IDLE");
        // The goodbye finishes first; the call ends at the end of that turn.
        later(() => end("said_bye"), 900);
        return;
      }
      default:
        answerTool(call.id, call.name, { ok: false, reason: "unknown_tool" }, "INTERRUPT");
    }
  };

  const undoPendingSend = () => {
    const send = openSend;
    if (send === null || send.cancelled) return;
    send.cancelled = true;
    openSend = null;
    const held = state.pending;
    publish({
      pending: held === null ? null : { ...held, cancelled: true },
      work: workFor(),
    });
    later(() => {
      if (state.pending?.cancelled === true) publish({ pending: null });
    }, 600);
    // The tool call is answered the moment the owner undoes it, so the voice
    // can say "OK, I didn't send it" without waiting out the window.
    answerTool(send.toolCallId, "send_to_bot", { ok: false, cancelled_by_user: true }, "INTERRUPT");
  };

  const openSocket = () => {
    if (session === null || ended) return;
    const handle = live?.resumeHandle ?? null;
    live = connectLive({
      model: session.model,
      // The server's own persona and chat context are already inside
      // systemInstruction, so no extra context text rides along.
      fallbackModel: session.fallbackModel,
      voiceName: session.voiceName,
      token: session.token,
      systemInstruction: session.systemInstruction,
      resumeHandle: handle,
      ...(options.createSocket ? { createSocket: options.createSocket } : {}),
      ...(options.setupTimeoutMs === undefined ? {} : { setupTimeoutMs: options.setupTimeoutMs }),
      events: {
        onSetupComplete: () => {
          const resumed = everConnected;
          everConnected = true;
          reconnectSinceMs = null;
          if (!resumed) options.audio.cue("connected");
          publish({ status: "live", pill: state.muted ? "muted" : "listening", hint: null });
        },
        onAudio: ({ base64, rate }) => {
          lastSpeechAtMs = now();
          if (state.pill !== "speaking" && !state.muted) publish({ pill: "speaking" });
          options.audio.play(base64, rate);
        },
        onCaption: ({ who, text, finished }) => {
          if (text.length === 0) return;
          lastSpeechAtMs = now();
          // A finished line joins the transcript before the snapshot is built,
          // so the stored transcript and the live caption never disagree.
          if (finished) {
            noteTranscript(
              decodeTranscriptEntry({ at: new Date(now()).toISOString(), speaker: who, text }),
            );
          }
          publish({ caption: { who, text } });
        },
        onInterrupted: () => {
          options.audio.stopPlayback();
          if (!ended) publish({ pill: state.muted ? "muted" : "listening" });
        },
        onTurnComplete: () => {
          if (ended) return;
          publish({ pill: state.muted ? "muted" : "listening" });
        },
        onToolCall,
        onGrounding: ({ queries }) => {
          // Google's own Search answered: the pill says so until the voice
          // finishes the sentence. Nothing is posted into the chat.
          if (ended || queries.length === 0) return;
          publish({ pill: "searching" });
        },
        onGoAway: () => {
          // Silent by design: shown only if the reconnect drags on.
          reconnectSinceMs ??= now();
        },
        onClosed: ({ refused, code, reason, quota }) => {
          if (ended) return;
          if (!everConnected) {
            errorDetail = reason.length > 0 ? reason : `Gemini closed the call (${code}).`;
            // A pass that is fine but a key that is out of quota closes the
            // socket the same way a dropped line does, with 1011 and Google's
            // own words. Naming it is the difference between "try again" and
            // "your free tier is spent", which is what the owner needs to know
            // (measured on the live key, 15 Oct 2026).
            publish({
              status: "error",
              errorCode: refused ? "key_rejected" : quota ? "key_quota" : "google_unavailable",
              pill: "none",
              hint: null,
            });
            end("failed");
            return;
          }
          // A live call that dropped: reconnect silently (the spec only shows
          // the Reconnecting state if it drags on) and hand the resume handle
          // back so the context survives.
          const firstDrop = reconnectSinceMs === null;
          reconnectSinceMs ??= now();
          if (firstDrop) openSocket();
        },
        onSetupTimeout: () => {
          if (!ended) publish({ status: "connecting" });
        },
        onError: ({ message }) => {
          errorDetail = message;
        },
      },
    });
  };

  const startTimer = () => {
    tick = setInterval(() => {
      if (ended) return;
      const at = now();
      const limit = limitPointsMs(maxCallMinutes());

      if (at - startedAtMs >= limit.endAtMs) {
        end("limit");
        return;
      }
      if (!limitWarned && at - startedAtMs >= limit.warnAtMs) {
        limitWarned = true;
        publish({ nearLimit: true });
      }

      // A reconnect that is over in under 1.5 s must show nothing at all.
      if (reconnectSinceMs !== null) {
        const down = at - reconnectSinceMs;
        if (down >= VOICE_RECONNECT_GIVE_UP_MS) {
          end("dropped");
          return;
        }
        if (down >= VOICE_RECONNECT_HIDDEN_MS && state.status !== "reconnecting") {
          publish({ status: "reconnecting", pill: "reconnecting" });
        }
        return;
      }

      // Waiting on the bot has its own cap, whatever the quiet setting says.
      if (waitingSinceMs !== null) {
        if (at - waitingSinceMs >= VOICE_WAITING_CAP_MS) {
          end("waiting_cap");
          return;
        }
      }

      const quietInput = {
        nowMs: at,
        lastSpeechAtMs,
        quietMinutes: quietMinutes(),
        // Waiting on the bot pauses the quiet timer (spec 5): the waiting cap
        // above is what ends a call nobody is talking on.
        pendingSend:
          (state.pending !== null && !state.pending.cancelled) || waitingSinceMs !== null,
      };
      if (!quietWarned && at >= quietWarningAtMs(quietInput) && at < quietDeadlineMs(quietInput)) {
        quietWarned = true;
        publish({ quietWarning: true });
      }
      if (quietExpired(quietInput)) {
        end("quiet");
        return;
      }

      const work = workFor();
      const hint = callHint({ state, waitingMs: at - startedAtMs });
      if (
        work?.kind !== state.work?.kind ||
        work?.detail !== state.work?.detail ||
        hint !== state.hint
      ) {
        publish({ work, hint });
      }
    }, 1_000);
  };

  const start = async (): Promise<void> => {
    const result = await options.api.start(options.threadId);
    if (!result.ok) {
      errorDetail = result.detail;
      publish({ status: "error", errorCode: result.code, pill: "none", hint: null });
      return;
    }
    session = result.value;
    publish({ status: "connecting", pill: "none", hint: null });
    openSocket();
    later(() => {
      if (!ended && !everConnected) {
        publish({ hint: callHint({ state, waitingMs: 400 }) });
      }
    }, 400);
    try {
      await options.audio.startMic();
      micStarted = true;
    } catch (error) {
      errorDetail = error instanceof Error ? error.message : "Microphone unavailable.";
      publish({ status: "error", errorCode: "unknown", pill: "none", hint: null });
      end("failed");
      return;
    }
    if (!ended) startTimer();
  };

  return {
    start,
    sendAudio: (pcm: ArrayBuffer) => live?.sendAudio(pcm),
    undoPendingSend,
    interrupted: () => options.audio.stopPlayback(),
    botTurnEnded: () => {
      waitingSinceMs = null;
      if (pendingAnswers.length > 0) answerOwedToolCalls("WHEN_IDLE");
      else publish({ work: workFor() });
    },
    noteTranscript,
    readLevel: () =>
      options.audio.readLevel(
        state.pill === "speaking" || state.pill === "reading" ? "voice" : "mic",
      ),
    setMuted: (muted: boolean) => {
      options.audio.setMuted(muted);
      try {
        options.audio.cue(muted ? "mute" : "unmute");
      } catch {
        // No audio: the state still changes.
      }
      publish({
        muted,
        pill: muted ? "muted" : state.pill === "muted" ? "listening" : state.pill,
      });
    },
    snapshot,
    end,
    dispose: () => {
      if (tick !== null) clearInterval(tick);
      tick = null;
      for (const timer of timeouts) clearTimeout(timer);
      timeouts.clear();
    },
    get session() {
      return session;
    },
    get ended() {
      return ended;
    },
  };
}
