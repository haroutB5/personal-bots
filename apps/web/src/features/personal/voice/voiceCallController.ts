/**
 * The call engine: it owns the session, the socket, the timers and every rule
 * that ends a call. The React provider is a thin wrapper around it and the
 * screen is a renderer, so the whole call can be driven by a fake socket and a
 * fake API in a test.
 *
 * Rules that come straight from the brief and the spec, plus the pre-ship
 * review's fixes (15 Oct 2026):
 * - `send_to_bot` is NON_BLOCKING and never lies. The Undo card holds the
 *   message for 3 seconds; the tool call is answered only once the real send
 *   resolved, and while the bot is working the answer waits for the real end of
 *   its turn so it can carry the redacted reply with WHEN_IDLE scheduling.
 * - A second `send_to_bot` while one is held queues behind it; a fourth is
 *   refused with `one_at_a_time`. A Google `toolCallCancellation`, and "no,
 *   wait" said out loud, both take the message back before it posts.
 * - One call, always torn down: the start slot is reserved synchronously, every
 *   await re-checks `ended`, and the audio is closed on every end path even if
 *   the microphone permission resolves afterwards.
 * - A goAway is not a drop. The replacement socket opens with the resumption
 *   handle and the same single-use pass, and callbacks from the stale socket
 *   are ignored.
 * - The card is retried until the server acknowledges it.
 * - A call that never connected leaves nothing in the chat.
 * - `finish()` runs exactly once per call, whatever ended it.
 * - A user tapping Stop is not an error: it ends as `hung_up`, never as a drop.
 *
 * Everything the voice is told about the chat goes through `redactForVoice`
 * and is length-capped first: the server redacts too, but the browser must not
 * forward raw chat text to Google on its own account.
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

import type { VoiceCallAnyErrorCode, VoiceCallFinishInput, VoiceCallSession } from "./voiceCallApi";
import {
  INITIAL_VOICE_CALL_STATE,
  VOICE_CONNECT_TIMEOUT_MS,
  VOICE_FINISH_RETRY_MS,
  VOICE_GOODBYE_SPOKEN_LINE,
  VOICE_QUIET_SPOKEN_LINE,
  VOICE_RECONNECT_GIVE_UP_MS,
  VOICE_RECONNECT_HIDDEN_MS,
  VOICE_REPLY_GRACE_MS,
  VOICE_SEND_QUEUE_MAX,
  VOICE_UNDO_MS,
  VOICE_WAITING_CAP_MS,
  VOICE_CALL_LOST_LINE,
  type VoiceCallState,
  type VoiceEndReason,
  type VoiceWorkCard,
  callHint,
  endReasonLine,
  isVoiceCancelPhrase,
  limitPointsMs,
  quietDeadlineMs,
  quietExpired,
  quietWarningAtMs,
  spokenInstruction,
} from "./callState";
import { redactForVoice } from "./voiceRedaction";

/**
 * One server answer, as the engine reads it. The provider maps the RPC's own
 * result onto this, so the engine never knows a transport exists.
 */
export type VoiceApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: VoiceCallAnyErrorCode; readonly detail: string };

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

/**
 * What the engine reads about the real bot. The provider supplies it from the
 * server's snapshot of the call's OWN chat, never from the chat on screen, and
 * keeps the last known answer rather than reporting `idle` when that chat is
 * not mounted.
 */
export interface BotStatusPort {
  /** "working", "idle", "needs_help", ... */
  readonly state: string;
  /**
   * The app's own word for the state ("Working", "Waiting on you"), when the
   * source has one. This is what the voice is told; `state` is for the engine.
   */
  readonly label?: string | null;
  /** The chat's own current progress line, or null. */
  readonly step: string | null;
  /** How long the current turn has been running, ms, or null. */
  readonly elapsedMs: number | null;
  /** The bot's latest reply text in the chat, or null. */
  readonly latestReply: string | null;
  /**
   * That reply's own message id and time, when the source knows them. A turn
   * that ends with no new text leaves the previous reply in place, so the
   * engine only hands the voice a reply whose message really is new (Fable's
   * re-check): without this it replayed the last turn's answer.
   */
  readonly latestReplyMessageId?: string | null;
  readonly latestReplyAtMs?: number | null;
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
  /** Live look at the real bot, bound to this call's own thread. */
  readonly botStatus: () => BotStatusPort;
  /**
   * Asks the server for a fresh snapshot of the call's chat, right now. Used
   * when the voice asks a question; the provider owns the RPC. Absent in a test
   * that drives the status directly.
   */
  readonly refreshBotStatus?: () => Promise<void>;
  readonly createSocket?: CreateLiveSocket;
  /** How long to wait for setupComplete before the endpoint is abandoned. */
  readonly setupTimeoutMs?: number;
  /** Hard cap on reaching a live session; past it the call fails. */
  readonly connectTimeoutMs?: number;
  /** The retry ladder for `finish`; a test shortens it. */
  readonly finishRetryMs?: ReadonlyArray<number>;
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
  interruptPlayback(): void;
  /** Called by the provider when the bot's turn really ends (WHEN_IDLE bookkeeping). */
  botTurnEnded(): void;
  /** Feed one transcribed line in, for the stored transcript. */
  noteTranscript(row: VoiceCallTranscriptEntry): void;
  /** Reads the live mic/voice level for the ring. Never a React render. */
  readLevel(): number;
  /** Mic on or off. The track is disabled, never stopped, so unmute is instant. */
  setMuted(muted: boolean): void;
  snapshot(): VoiceCallSnapshot;
  /**
   * Ends the call, exactly once, through `finish()`. `notice` replaces the
   * ended screen's line when the reason alone would not say what happened.
   */
  end(reason: VoiceEndReason, notice?: string): void;
  /**
   * True while the voice is waiting on the real bot: a message is held, or one
   * has posted and its reply is still owed. The provider polls the server
   * snapshot only while this is true (one small indexed read, not a loop).
   */
  readonly watchBot: boolean;
  /** The call is gone on the server: end it cleanly, with nothing retried. */
  callLost(): void;
  /** Attempts a card the server has not acknowledged yet. Safe to call often. */
  retryFinish(): void;
  /** True while a card is still owed to the server. */
  readonly finishPending: boolean;
  /** Removes every listener and timer this call added. */
  dispose(): void;
  readonly session: VoiceCallSession | null;
  readonly ended: boolean;
}

/**
 * The send the Undo card is holding. A second tool call queues behind it rather
 * than posting the first one early.
 */
interface OpenSend {
  readonly text: string;
  readonly atMs: number;
  readonly toolCallId: string;
  cancelled: boolean;
}

/** A posted message whose tool answer is still owed to the voice. */
interface OpenReply {
  readonly toolCallId: string;
  readonly messageId: string;
  readonly sentAtMs: number;
  /**
   * The chat's latest reply message when this send was posted, so a turn that
   * ends with no new text is never handed over as this send's answer.
   */
  readonly replyMessageIdBefore: string | null;
  readonly replyAtBeforeMs: number | null;
  /** True once the bot was really seen working on it. */
  sawWorking: boolean;
}

const RETRY_FINISH_FOREVER_MS = 60_000;

export function createVoiceCallController(
  options: VoiceCallControllerOptions,
): VoiceCallController {
  const now = options.now ?? (() => Date.now());
  const startedAtMs = now();
  const finishRetryMs = options.finishRetryMs ?? VOICE_FINISH_RETRY_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? VOICE_CONNECT_TIMEOUT_MS;
  let state: VoiceCallState = { ...INITIAL_VOICE_CALL_STATE };
  let transcript: VoiceCallTranscriptEntry[] = [];
  const sentMessageIds: string[] = [];
  let session: VoiceCallSession | null = null;
  let live: LiveClient | null = null;
  /** Bumped for every socket, so a stale one's callbacks are ignored. */
  let generation = 0;
  let ended = false;
  let started = false;
  let disposed = false;
  let everConnected = false;
  let errorDetail: string | null = null;
  let lastSpeechAtMs = startedAtMs;
  let quietWarned = false;
  let limitWarned = false;
  let byeSaid = false;
  let waitingSinceMs: number | null = null;
  /** The connection is down and a replacement is being opened. */
  let reconnectSinceMs: number | null = null;
  /** Google announced a planned rotation. This alone is not a drop. */
  let goAwayAtMs: number | null = null;
  let reconnectAttempts = 0;
  /** The send the Undo card is showing, first in line. */
  let sendQueue: OpenSend[] = [];
  /** The posted message the voice has not been told about yet. */
  let openReply: OpenReply | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let audioClosed = false;
  let pendingFinish: VoiceCallFinishInput | null = null;
  let finishAttempts = 0;
  let finishInFlight = false;
  /** The finish retry's own timer, kept out of `timeouts` so it can be reset alone. */
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  const timeouts = new Set<ReturnType<typeof setTimeout>>();

  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timeouts.delete(timer);
      fn();
    }, ms);
    timeouts.add(timer);
    return timer;
  };

  const clearFinishTimer = () => {
    if (finishTimer === null) return;
    clearTimeout(finishTimer);
    finishTimer = null;
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

  /** Reads the bot, redacted and capped, for anything the voice will hear. */
  const safeStatus = () => {
    const status = options.botStatus();
    return {
      state: status.state,
      label: status.label ?? null,
      step: redactForVoice(status.step) || null,
      elapsedMs: status.elapsedMs,
      latestReply: redactForVoice(status.latestReply) || null,
      latestReplyMessageId: status.latestReplyMessageId ?? null,
      latestReplyAtMs: status.latestReplyAtMs ?? null,
    };
  };

  const say = (line: string) => {
    try {
      live?.speak(spokenInstruction(line));
    } catch {
      // A dead socket: the on-screen line is still there.
    }
  };

  /**
   * One call card per call, with the reason, whatever ended it, retried until
   * the server acknowledges it: a brief offline or a locked phone must not cost
   * the card (review finding 7).
   *
   * The lease is closed by `finish` alone, so this runs for a call that never
   * connected too (cancelled while connecting, or refused by Google with
   * 1007/1011): returning early left its row holding both restart gates until
   * it expired (QA bug 2). `session` is the only hard requirement, because
   * without a call id there is nothing on the server to close.
   */
  const finish = (reason: VoiceEndReason) => {
    if (pendingFinish !== null || session === null) return;
    pendingFinish = {
      threadId: decodeThreadId(options.threadId),
      callId: session.callId,
      startedAt: DateTime.makeUnsafe(startedAtMs),
      endedAt: DateTime.makeUnsafe(now()),
      endReason: reason,
      transcript,
      sentMessageIds: sentMessageIds.map((id) => decodeMessageId(id)),
      ...(errorDetail === null ? {} : { detail: errorDetail.slice(0, 400) }),
    };
    void flushFinish();
  };

  const flushFinish = async (): Promise<void> => {
    if (disposed || finishInFlight || pendingFinish === null) return;
    const payload = pendingFinish;
    finishInFlight = true;
    let ok = false;
    try {
      const result = await options.api.finish(payload);
      ok = result.ok;
    } catch {
      ok = false;
    }
    finishInFlight = false;
    if (ok) {
      pendingFinish = null;
      return;
    }
    if (disposed) return;
    const delay =
      finishAttempts < finishRetryMs.length
        ? finishRetryMs[finishAttempts]!
        : RETRY_FINISH_FOREVER_MS;
    finishAttempts += 1;
    clearFinishTimer();
    finishTimer = setTimeout(() => {
      finishTimer = null;
      void flushFinish();
    }, delay);
  };

  const closeAudio = () => {
    if (audioClosed) return;
    audioClosed = true;
    try {
      options.audio.close();
    } catch {
      // Nothing left to close.
    }
  };

  const end = (reason: VoiceEndReason, notice?: string) => {
    if (ended) return;
    ended = true;
    if (tick !== null) clearInterval(tick);
    tick = null;
    if (connectTimer !== null) clearTimeout(connectTimer);
    connectTimer = null;
    try {
      live?.stop();
    } catch {
      // Already closed.
    }
    live = null;
    // Always, whether or not the mic ever came up: a permission prompt that
    // resolves after this must not leave a live stream behind (finding 4).
    closeAudio();
    sendQueue = [];
    openReply = null;
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
      // `notice` is for the endings the reason alone would not explain, like the
      // laptop restarting under the call.
      hint: notice ?? endReasonLine(reason, quietMinutes()),
      pending: null,
      work: null,
    });
  };

  /**
   * The server no longer knows this call: its lease is gone, which in practice
   * means the laptop restarted under it. Nothing is retried and the call ends
   * cleanly, saying so.
   */
  const callLost = () => {
    if (ended) return;
    errorDetail = VOICE_CALL_LOST_LINE;
    end("dropped", VOICE_CALL_LOST_LINE);
  };

  const workFor = (): VoiceWorkCard | null => {
    const head = sendQueue[0] ?? null;
    if (head !== null) {
      return { kind: "sending", title: "", detail: head.text, sinceMs: head.atMs };
    }
    const status = safeStatus();
    if (status.state === "working") {
      return { kind: "working", title: "", detail: status.step ?? "", sinceMs: null };
    }
    if (status.latestReply !== null && status.latestReply.length > 0) {
      return { kind: "replied", title: "", detail: status.latestReply, sinceMs: null };
    }
    return null;
  };

  const pendingCard = () => {
    const head = sendQueue[0];
    if (head === undefined || head.cancelled) return null;
    return {
      text: head.text,
      atMs: head.atMs,
      dueAtMs: head.atMs + VOICE_UNDO_MS,
      cancelled: false,
    };
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

  /** Posts one held message, as the owner's own message. */
  const postSend = async (send: OpenSend): Promise<void> => {
    if (session === null || ended) return;
    let result: VoiceApiResult<{ readonly messageId: string }>;
    try {
      result = await options.api.send({
        threadId: options.threadId,
        callId: session.callId,
        text: send.text,
      });
    } catch (error) {
      result = {
        ok: false,
        code: "google_unavailable",
        detail: error instanceof Error ? error.message : "The send failed.",
      };
    }
    if (ended) return;
    if (!result.ok) {
      errorDetail = result.detail;
      // The voice is told the truth at once: nothing was sent, and why.
      answerTool(
        send.toolCallId,
        "send_to_bot",
        { ok: false, reason: result.code, detail: result.detail.slice(0, 200) },
        "INTERRUPT",
      );
      publish({ work: workFor() });
      // `not_found` is the lease being gone: the laptop restarted, or the call
      // was ended elsewhere. Nothing is retried; the call ends cleanly.
      if (result.code === "not_found") callLost();
      return;
    }
    sentMessageIds.push(result.value.messageId);
    options.onSent?.({ messageId: result.value.messageId, text: send.text });
    // The card in the chat counts what went, so the snapshot has to catch up.
    publish({});
    // What the chat already held before this send: the reply handed over at the
    // end of the turn must be a different message, or it is the last turn's.
    const before = safeStatus();
    // The answer carries the real id, and waits for the bot's turn when there
    // is one to wait for, so the voice can read the reply the moment it lands.
    openReply = {
      toolCallId: send.toolCallId,
      messageId: result.value.messageId,
      sentAtMs: now(),
      replyMessageIdBefore: before.latestReplyMessageId,
      replyAtBeforeMs: before.latestReplyAtMs,
      sawWorking: false,
    };
    if (before.state === "working") {
      openReply.sawWorking = true;
      waitingSinceMs ??= now();
    }
  };

  /**
   * True only when the chat holds a reply this send did not already have. A
   * turn that ends with no new text leaves the previous reply in the chat, and
   * handing that over claims work the bot never did (Fable's re-check).
   */
  const replyIsNew = (delivery: OpenReply, status: ReturnType<typeof safeStatus>): boolean => {
    if (status.latestReply === null || status.latestReply.length === 0) return false;
    const id = status.latestReplyMessageId;
    if (id !== null && id.length > 0 && delivery.replyMessageIdBefore !== null) {
      return id !== delivery.replyMessageIdBefore;
    }
    const atMs = status.latestReplyAtMs;
    if (atMs !== null && delivery.replyAtBeforeMs !== null) {
      return atMs > delivery.replyAtBeforeMs;
    }
    // A source that cannot name the reply: keep the old behaviour rather than
    // swallow a real answer.
    return true;
  };

  /** Hands the voice the send result, with the reply when there is one. */
  const deliverReply = (withReply: boolean) => {
    const delivery = openReply;
    if (delivery === null) return;
    openReply = null;
    waitingSinceMs = null;
    const status = safeStatus();
    const reply = withReply && replyIsNew(delivery, status) ? status.latestReply : null;
    answerTool(
      delivery.toolCallId,
      "send_to_bot",
      {
        ok: true,
        status: "sent",
        messageId: delivery.messageId,
        ...(reply === null || reply.length === 0 ? {} : { reply }),
      },
      "WHEN_IDLE",
    );
    publish({ work: workFor() });
  };

  /**
   * Opens the Undo window for the head of the queue. Called when a send is
   * first held and again each time the head leaves the queue.
   */
  const openWindow = () => {
    const head = sendQueue[0];
    if (head === undefined) {
      publish({ pending: null, work: workFor() });
      return;
    }
    publish({
      pending: {
        text: head.text,
        atMs: head.atMs,
        dueAtMs: head.atMs + VOICE_UNDO_MS,
        cancelled: false,
      },
      work: { kind: "sending", title: "", detail: head.text, sinceMs: head.atMs },
    });
    later(() => {
      void closeWindow(head);
    }, VOICE_UNDO_MS);
  };

  /** The head's window ran out: post it, then open the next one's. */
  const closeWindow = async (send: OpenSend) => {
    if (ended) return;
    if (send.cancelled || sendQueue[0] !== send) return;
    sendQueue = sendQueue.slice(1);
    publish({ pending: pendingCard(), work: workFor() });
    await postSend(send);
    if (ended) return;
    if (sendQueue.length > 0) openWindow();
  };

  const dropFromQueue = (toolCallId: string): boolean => {
    const index = sendQueue.findIndex((send) => send.toolCallId === toolCallId);
    if (index < 0) return false;
    const wasHead = index === 0;
    sendQueue = [...sendQueue.slice(0, index), ...sendQueue.slice(index + 1)];
    return wasHead;
  };

  /** Answers `bot_status` or `latest_reply` from a just-fetched snapshot. */
  const answerStatusQuestion = async (call: LiveToolCall, name: string): Promise<void> => {
    try {
      await options.refreshBotStatus?.();
    } catch {
      // The last known answer is the answer; the voice is never left hanging.
    }
    if (ended) return;
    const status = safeStatus();
    if (name === "latest_reply") {
      answerTool(call.id, call.name, { reply: status.latestReply ?? "" }, "INTERRUPT");
      return;
    }
    answerTool(
      call.id,
      call.name,
      {
        // The app's own word when the source has one ("Working"), so the voice
        // repeats what the chat really says.
        state: status.label ?? status.state,
        step: status.step,
        elapsedSeconds: status.elapsedMs === null ? null : Math.round(status.elapsedMs / 1_000),
      },
      "INTERRUPT",
    );
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
        // Three held at once is the ceiling; past that the voice is told to
        // wait rather than the queue growing without bound.
        if (sendQueue.length >= VOICE_SEND_QUEUE_MAX) {
          answerTool(call.id, call.name, { ok: false, reason: "one_at_a_time" }, "INTERRUPT");
          return;
        }
        const queued: OpenSend = {
          text,
          atMs: now(),
          toolCallId: call.id,
          cancelled: false,
        };
        const wasEmpty = sendQueue.length === 0;
        sendQueue = [...sendQueue, queued];
        if (wasEmpty) openWindow();
        else publish({ work: workFor() });
        return;
      }
      case "bot_status": {
        // The voice asked, so the server is asked now: the snapshot is not
        // polled while nothing is waiting on the bot.
        void answerStatusQuestion(call, "bot_status");
        return;
      }
      case "latest_reply": {
        void answerStatusQuestion(call, "latest_reply");
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

  /** Google took a tool call back: the held message never posts. */
  const onToolCallCancellation = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      if (openReply?.toolCallId === id) openReply = null;
      const wasHead = dropFromQueue(id);
      if (!wasHead) continue;
      // No answer is sent for a cancelled call: Google already withdrew it.
      publish({ pending: pendingCard(), work: workFor() });
      if (sendQueue.length > 0) openWindow();
    }
  };

  const undoPendingSend = () => {
    const head = sendQueue[0];
    if (head === undefined || head.cancelled) return;
    head.cancelled = true;
    sendQueue = sendQueue.slice(1);
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
    answerTool(head.toolCallId, "send_to_bot", { ok: false, cancelled_by_user: true }, "INTERRUPT");
    if (sendQueue.length > 0) openWindow();
  };

  const openSocket = () => {
    if (session === null || ended || disposed) return;
    // Read the handle before the old client is replaced: a goAway's handle is
    // what lets the replacement keep the conversation and the audio.
    const handle = live?.resumeHandle ?? null;
    generation += 1;
    const myGeneration = generation;
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
          if (myGeneration !== generation || ended) return;
          const resumed = everConnected;
          everConnected = true;
          reconnectSinceMs = null;
          goAwayAtMs = null;
          reconnectAttempts = 0;
          if (connectTimer !== null) clearTimeout(connectTimer);
          connectTimer = null;
          if (!resumed) options.audio.cue("connected");
          publish({ status: "live", pill: state.muted ? "muted" : "listening", hint: null });
        },
        onAudio: ({ base64, rate }) => {
          if (myGeneration !== generation) return;
          lastSpeechAtMs = now();
          if (state.pill !== "speaking" && !state.muted) publish({ pill: "speaking" });
          options.audio.play(base64, rate);
        },
        onCaption: ({ who, text, finished }) => {
          if (myGeneration !== generation) return;
          if (text.length === 0) return;
          lastSpeechAtMs = now();
          // "No, wait" takes the held message back, exactly like tapping Undo.
          if (who === "you" && finished && sendQueue.length > 0 && isVoiceCancelPhrase(text)) {
            undoPendingSend();
          }
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
          if (myGeneration !== generation) return;
          options.audio.stopPlayback();
          if (!ended) publish({ pill: state.muted ? "muted" : "listening" });
        },
        onTurnComplete: () => {
          if (myGeneration !== generation || ended) return;
          publish({ pill: state.muted ? "muted" : "listening" });
        },
        onToolCall,
        onToolCallCancellation,
        onGrounding: ({ queries }) => {
          // Google's own Search answered: the pill says so until the voice
          // finishes the sentence. Nothing is posted into the chat.
          if (myGeneration !== generation || ended || queries.length === 0) return;
          publish({ pill: "searching" });
        },
        onGoAway: () => {
          // A planned rotation, not a drop: remembered only so the connection
          // going down afterwards is treated as expected rather than as a fault.
          if (myGeneration !== generation) return;
          goAwayAtMs ??= now();
        },
        onClosed: ({ refused, code, reason, quota }) => {
          if (myGeneration !== generation || ended) return;
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
          // A live call that dropped, or a planned rotation: open a replacement
          // with the resumption handle on the SAME single-use pass (Google
          // accepts it inside the token's expiry, proved 15 Oct 2026). The spec
          // only shows Reconnecting if it drags on.
          reconnectSinceMs ??= now();
          if (reconnectAttempts >= 5) return;
          const delay = reconnectAttempts === 0 ? 0 : 500;
          reconnectAttempts += 1;
          later(() => {
            if (!ended) openSocket();
          }, delay);
        },
        onSetupTimeout: () => {
          if (myGeneration !== generation || ended) return;
          publish({ status: "connecting" });
        },
        onError: ({ message }) => {
          if (myGeneration !== generation) return;
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
      // 29:45: the voice says goodbye out loud before the cap ends the call
      // (spec 5). Once only.
      if (!byeSaid && at - startedAtMs >= limit.byeAtMs) {
        byeSaid = true;
        say(VOICE_GOODBYE_SPOKEN_LINE);
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

      // A posted message the voice has not been told about yet. The bot's turn
      // usually starts within the grace window; if it never does, the voice is
      // still told the truth about the send.
      if (openReply !== null) {
        const working = safeStatus().state === "working";
        if (working) {
          openReply.sawWorking = true;
          waitingSinceMs ??= at;
        } else if (openReply.sawWorking || at - openReply.sentAtMs >= VOICE_REPLY_GRACE_MS) {
          deliverReply(openReply.sawWorking);
        }
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
        pendingSend: sendQueue.length > 0 || waitingSinceMs !== null || openReply !== null,
      };
      if (!quietWarned && at >= quietWarningAtMs(quietInput) && at < quietDeadlineMs(quietInput)) {
        quietWarned = true;
        // Said out loud as well as shown: the owner may be looking away.
        say(VOICE_QUIET_SPOKEN_LINE);
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
    // The slot is taken synchronously: two taps in the same frame must not mint
    // two passes (finding 4).
    if (started) return;
    started = true;
    const result = await options.api.start(options.threadId);
    if (disposed) return;
    if (!result.ok) {
      errorDetail = result.detail;
      publish({ status: "error", errorCode: result.code, pill: "none", hint: null });
      return;
    }
    if (ended) return;
    session = result.value;
    publish({ status: "connecting", pill: "none", hint: null });
    openSocket();
    // The hard cap: whatever the socket is doing, past this the call is over.
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (ended || promisedLive()) return;
      errorDetail = "Google did not answer in time.";
      publish({
        status: "error",
        errorCode: "google_unavailable",
        pill: "none",
        hint: null,
      });
      end("failed");
    }, connectTimeoutMs);
    later(() => {
      if (!ended && !everConnected) {
        publish({ hint: callHint({ state, waitingMs: 400 }) });
      }
    }, 400);
    try {
      await options.audio.startMic();
    } catch (error) {
      if (disposed) return;
      errorDetail = error instanceof Error ? error.message : "Microphone unavailable.";
      publish({ status: "error", errorCode: "unknown", pill: "none", hint: null });
      end("failed");
      return;
    }
    // The call can end while the microphone prompt is up: then the audio is
    // already closed and no timer may start.
    if (ended || disposed) {
      closeAudio();
      return;
    }
    startTimer();
  };

  /** True once a session answered or a replacement is already under way. */
  const promisedLive = () => everConnected || reconnectSinceMs !== null || live?.ready === true;

  return {
    start,
    sendAudio: (pcm: ArrayBuffer) => live?.sendAudio(pcm),
    undoPendingSend,
    interruptPlayback: () => options.audio.stopPlayback(),
    botTurnEnded: () => {
      waitingSinceMs = null;
      if (openReply !== null) {
        deliverReply(true);
        return;
      }
      publish({ work: workFor() });
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
    callLost,
    get watchBot() {
      // A message is held, or one has posted and its reply is still owed: the
      // only times the server's snapshot is worth polling.
      return sendQueue.length > 0 || openReply !== null;
    },
    retryFinish: () => {
      if (pendingFinish === null || finishInFlight) return;
      clearFinishTimer();
      finishAttempts = 0;
      void flushFinish();
    },
    get finishPending() {
      return pendingFinish !== null;
    },
    dispose: () => {
      disposed = true;
      if (tick !== null) clearInterval(tick);
      tick = null;
      if (connectTimer !== null) clearTimeout(connectTimer);
      connectTimer = null;
      clearFinishTimer();
      for (const timer of timeouts) clearTimeout(timer);
      timeouts.clear();
      try {
        live?.stop();
      } catch {
        // Already closed.
      }
      live = null;
      closeAudio();
    },
    get session() {
      return session;
    },
    get ended() {
      return ended;
    },
  };
}
