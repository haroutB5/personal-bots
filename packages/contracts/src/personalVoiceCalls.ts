import * as Schema from "effect/Schema";

import { MessageId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";

/**
 * Voice calls with a bot (Harout, 15 Oct 2026): the phone talks to Google
 * Gemini Live through a short-lived token the hbots server mints from the
 * saved `GEMINI_API_KEY`, and anything worth real work is posted into the chat
 * so the bot's own turn does it.
 *
 * Three rules shape this contract and the server behind it:
 *
 * 1. The voice speaks **as the bot itself**, first person ("Sure, I'll look at
 *    that"), never as a middle bot relaying to it. It may still only report
 *    what the bot's real replies and status say.
 * 2. The key never reaches the phone. The server mints one single-use token
 *    per call and the client connects with that.
 * 3. A call leaves two records in the chat: each message the voice sent (a
 *    normal owner message carrying {@link PERSONAL_VOICE_CALL_CONTEXT_KIND})
 *    and one call card (a row in `personal_voice_calls`, listed by
 *    {@link VoiceCallListResult}). Neither is ever fed into a bot's model
 *    context.
 *
 * The settings constants live in `personalVoiceCallSettings.ts`, re-exported
 * from the package index beside this module.
 */

/** The Gemini Live model a call runs on. */
export const VOICE_CALL_MODEL = "gemini-3.8-live";
/** Tried when the primary model refuses the session. */
export const VOICE_CALL_FALLBACK_MODEL = "gemini-3.1-flash-live-preview";
/** Hard cap on one call, in minutes. The minted token also expires at this point. */
export const VOICE_CALL_MAX_MINUTES = 30;
/** The single-use token is dead this long after it is minted. */
export const VOICE_CALL_TOKEN_TTL_SECONDS = 30 * 60;
/** A session must be opened this long after the token is minted. */
export const VOICE_CALL_NEW_SESSION_TTL_SECONDS = 60;
/** How many start calls one client may make per minute. */
export const VOICE_CALL_STARTS_PER_MINUTE = 6;

/** At most this many recent chat messages are handed to a call as context. */
export const VOICE_CALL_CONTEXT_MESSAGES = 20;

/** At most this many transcript rows are stored on one call. */
export const VOICE_CALL_MAX_TRANSCRIPT_ENTRIES = 400;
/** At most this many characters per transcript row. */
export const VOICE_CALL_MAX_TRANSCRIPT_CHARS = 2_000;

/** At most this many characters the voice may send as one message. */
export const VOICE_CALL_MAX_SENT_CHARS = 4_000;

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export const VoiceCallStartInput = Schema.Struct({
  threadId: ThreadId,
});
export type VoiceCallStartInput = typeof VoiceCallStartInput.Type;

/** One recent chat message handed to the call as context. */
export const VoiceCallContextMessage = Schema.Struct({
  role: Schema.Literals(["user", "bot"]),
  text: Schema.String,
  at: Schema.DateTimeUtcFromString,
});
export type VoiceCallContextMessage = typeof VoiceCallContextMessage.Type;

/**
 * What the voice knows when the call starts. The same material is already
 * inside {@link VoiceCallStartResult.systemInstruction}; this is the readable
 * form, for the call screen's work card and for the client's own use.
 */
export const VoiceCallContext = Schema.Struct({
  botId: PersonalBotId,
  botName: Schema.String,
  /** Empty string when the bot has no title. */
  botTitle: Schema.String,
  /** The owner's display name, empty when unset. */
  displayName: Schema.String,
  /** The bot's live status line, e.g. "Working" or "Idle". */
  botStatus: Schema.String,
  /** The current step line while the bot works; empty when it is not working. */
  botStatusDetail: Schema.String,
  /**
   * Titles of the bot's unfinished tasks, newest first (titles only, never a
   * brief or a result). A title the owner wrote is safe to say out loud.
   */
  runningTaskTitles: Schema.Array(Schema.String),
  /** Up to the last 20 text messages of the chat, oldest first. */
  recentMessages: Schema.Array(VoiceCallContextMessage),
  /**
   * Cards the chat is holding that the voice must only mention, never read:
   * "CTO needs a login for vercel.com", "CTO needs a secret (GITHUB_TOKEN)".
   */
  callouts: Schema.Array(Schema.String),
});
export type VoiceCallContext = typeof VoiceCallContext.Type;

export const VoiceCallStartResult = Schema.Struct({
  /** Mints once per start; every later call this id is idempotent. */
  callId: TrimmedNonEmptyString,
  /**
   * The ephemeral Gemini token (`auth_tokens/...`). Single use, dead 30
   * minutes after minting, and only accepted by the `...Constrained` WebSocket
   * methods as the `access_token` query parameter. This is the only thing the
   * phone ever gets; the API key stays on the laptop.
   */
  token: Schema.String,
  tokenExpiresAt: Schema.DateTimeUtcFromString,
  /** The session must be opened by this time or the token is spent. */
  newSessionExpiresAt: Schema.DateTimeUtcFromString,
  model: Schema.String,
  /** The model the client falls back to if the session refuses the primary. */
  fallbackModel: Schema.String,
  voiceName: Schema.String,
  quietHangupMinutes: Schema.Literals([1, 2, 5]),
  maxCallMinutes: Schema.Number,
  /** The bot's name, for the call screen's labels. */
  botName: Schema.String,
  /** Built server-side: the persona, the honesty rule and the chat context. */
  systemInstruction: Schema.String,
  context: VoiceCallContext,
});
export type VoiceCallStartResult = typeof VoiceCallStartResult.Type;

/**
 * Why a call could not start (or could not be checked). The call screen maps
 * each one to its own words and its own fix.
 *
 * - `no_key`: no `GEMINI_API_KEY` is saved.
 * - `key_rejected`: Google refused the saved key.
 * - `key_quota`: Google paused the key (free-tier quota, usually).
 * - `calls_not_allowed`: the bot's "Allow voice calls" switch is off.
 * - `not_owner_chat`: not an owner chat (a group, task or archived chat, or no
 *   bot behind the thread at all).
 * - `google_unavailable`: Google could not be reached, or answered 5xx.
 * - `rate_limited`: too many starts in a row from this client.
 * - `invalid_input`: a field the server cannot use.
 * - `not_found`: the chat or the call does not exist.
 */
export const VoiceCallErrorCode = Schema.Literals([
  "no_key",
  "key_rejected",
  "key_quota",
  "calls_not_allowed",
  "not_owner_chat",
  "google_unavailable",
  "rate_limited",
  "invalid_input",
  "not_found",
]);
export type VoiceCallErrorCode = typeof VoiceCallErrorCode.Type;

export class PersonalVoiceCallsError extends Schema.TaggedError<PersonalVoiceCallsError>()(
  "PersonalVoiceCallsError",
  {
    code: VoiceCallErrorCode,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// ---------------------------------------------------------------------------
// checkKey (Settings: "Checking this key...")
// ---------------------------------------------------------------------------

export const VoiceCallKeyCheckInput = Schema.Struct({});
export type VoiceCallKeyCheckInput = typeof VoiceCallKeyCheckInput.Type;

/**
 * What Settings shows after a key is saved. `ok` and `quota` both mean the key
 * is accepted and a real Live token was minted: `quota` adds that Google
 * reported the key is out of quota right now, which is worth saying instead of
 * letting the first call fail.
 */
export const VoiceCallKeyCheckStatus = Schema.Literals([
  "ok",
  "quota",
  "rejected",
  "missing",
  "unavailable",
]);
export type VoiceCallKeyCheckStatus = typeof VoiceCallKeyCheckStatus.Type;

export const VoiceCallKeyCheckResult = Schema.Struct({
  status: VoiceCallKeyCheckStatus,
  /** The origin the key is bound to; empty when there is no key. */
  origin: Schema.String,
});
export type VoiceCallKeyCheckResult = typeof VoiceCallKeyCheckResult.Type;

// ---------------------------------------------------------------------------
// lookupMemory (the voice's own fast facts)
// ---------------------------------------------------------------------------

/** At most this many memory entries one lookup returns. */
export const VOICE_CALL_LOOKUP_MEMORY_MAX = 8;
/** At most this many characters of an entry the voice is handed. */
export const VOICE_CALL_LOOKUP_MEMORY_CHARS = 400;
/** At most this many of the owner's standing rules go into the instruction. */
export const VOICE_CALL_PREFERENCES_MAX_ENTRIES = 40;

export const VoiceCallLookupMemoryInput = Schema.Struct({
  threadId: ThreadId,
  callId: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString,
});
export type VoiceCallLookupMemoryInput = typeof VoiceCallLookupMemoryInput.Type;

/** One entry the voice may say out loud. Never a value: memory refuses secrets. */
export const VoiceCallMemoryEntry = Schema.Struct({
  kind: Schema.String,
  content: Schema.String,
});
export type VoiceCallMemoryEntry = typeof VoiceCallMemoryEntry.Type;

export const VoiceCallLookupMemoryResult = Schema.Struct({
  entries: Schema.Array(VoiceCallMemoryEntry),
  /**
   * Empty when the lookup ran. Otherwise the reason it returned nothing, said
   * plainly so the voice can repeat it instead of guessing.
   */
  note: Schema.String,
});
export type VoiceCallLookupMemoryResult = typeof VoiceCallLookupMemoryResult.Type;

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

export const VoiceCallSendInput = Schema.Struct({
  threadId: ThreadId,
  callId: TrimmedNonEmptyString,
  /** The cleaned-up message, as spoken. Trimmed and length-checked server-side. */
  text: TrimmedNonEmptyString,
});
export type VoiceCallSendInput = typeof VoiceCallSendInput.Type;

export const VoiceCallSendResult = Schema.Struct({
  /** The message that landed in the chat, exactly as a typed send would. */
  messageId: MessageId,
  createdAt: Schema.DateTimeUtcFromString,
});
export type VoiceCallSendResult = typeof VoiceCallSendResult.Type;

/**
 * The context kind on a message the voice sent. The message reads as the
 * owner's own normal message and the bot sees it like a typed one; the marker
 * carries the call id, and because no text references it the provider's
 * projection drops it.
 */
export const PERSONAL_VOICE_CALL_CONTEXT_KIND = "personal-voice-call";

export const PersonalVoiceCallMessageMarker = Schema.Struct({
  callId: TrimmedNonEmptyString,
  /** Always "voice_call": where this message came from. */
  source: Schema.Literal("voice_call"),
});
export type PersonalVoiceCallMessageMarker = typeof PersonalVoiceCallMessageMarker.Type;

// ---------------------------------------------------------------------------
// finish (the call card)
// ---------------------------------------------------------------------------

/**
 * How a call ended, as the card's reason line says it. The client decides,
 * because only it knows whether the owner tapped End, said bye, was quiet, or
 * lost the line; the server stores whatever it is told, once.
 */
export const VoiceCallEndReason = Schema.Literals([
  "hung_up",
  "said_bye",
  "quiet",
  "waiting_cap",
  "left_app",
  "interrupted",
  "limit",
  "dropped",
  "failed",
]);
export type VoiceCallEndReason = typeof VoiceCallEndReason.Type;

export const VoiceCallSpeaker = Schema.Literals(["you", "voice"]);
export type VoiceCallSpeaker = typeof VoiceCallSpeaker.Type;

export const VoiceCallTranscriptEntry = Schema.Struct({
  speaker: VoiceCallSpeaker,
  text: Schema.String,
  at: Schema.DateTimeUtcFromString,
});
export type VoiceCallTranscriptEntry = typeof VoiceCallTranscriptEntry.Type;

export const VoiceCallFinishInput = Schema.Struct({
  threadId: ThreadId,
  callId: TrimmedNonEmptyString,
  startedAt: Schema.DateTimeUtcFromString,
  endedAt: Schema.DateTimeUtcFromString,
  endReason: VoiceCallEndReason,
  transcript: Schema.Array(VoiceCallTranscriptEntry),
  /** The messages the voice sent, in order: their ids as `send` returned them. */
  sentMessageIds: Schema.Array(MessageId),
  /** Free-text detail for a failed or dropped call; never shown to the bot. */
  detail: Schema.optional(Schema.String),
});
export type VoiceCallFinishInput = typeof VoiceCallFinishInput.Type;

/** The stored card. One row per call, keyed by `callId`. */
export const VoiceCallRecord = Schema.Struct({
  callId: TrimmedNonEmptyString,
  threadId: ThreadId,
  botId: PersonalBotId,
  startedAt: Schema.DateTimeUtcFromString,
  endedAt: Schema.DateTimeUtcFromString,
  durationSeconds: NonNegativeInt,
  endReason: VoiceCallEndReason,
  /** How many messages the voice sent to the bot. */
  messageCount: NonNegativeInt,
  voiceName: Schema.String,
  model: Schema.String,
  /** The detail given at finish, empty when none. */
  detail: Schema.String,
  transcript: Schema.Array(VoiceCallTranscriptEntry),
});
export type VoiceCallRecord = typeof VoiceCallRecord.Type;

export const VoiceCallFinishResult = Schema.Struct({
  call: VoiceCallRecord,
  /** True when this call already had a card and nothing was written again. */
  alreadyStored: Schema.Boolean,
});
export type VoiceCallFinishResult = typeof VoiceCallFinishResult.Type;

// ---------------------------------------------------------------------------
// list (the chat's cards)
// ---------------------------------------------------------------------------

export const VoiceCallListInput = Schema.Struct({
  threadId: ThreadId,
});
export type VoiceCallListInput = typeof VoiceCallListInput.Type;

/**
 * The chat's call cards, newest first. The client drops each one into the
 * transcript at its `startedAt`, the way a delegated task's card is placed.
 */
export const VoiceCallListResult = Schema.Struct({
  calls: Schema.Array(VoiceCallRecord),
});
export type VoiceCallListResult = typeof VoiceCallListResult.Type;

/** The card's reason line, in the owner's words. */
export const voiceCallEndReasonLabel = (reason: VoiceCallEndReason): string =>
  reason === "hung_up"
    ? "You hung up."
    : reason === "said_bye"
      ? "Ended when you said bye."
      : reason === "quiet"
        ? "Ended after a quiet spell."
        : reason === "waiting_cap"
          ? "Ended while the bot worked. The reply will come here."
          : reason === "left_app"
            ? "Ended when you left the app."
            : reason === "interrupted"
              ? "Ended by another call."
              : reason === "limit"
                ? "Ended at the 30-minute limit."
                : reason === "dropped"
                  ? "The call dropped."
                  : "The call could not start.";
