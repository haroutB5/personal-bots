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
// the call summary (Harout, 16 Oct 2026)
// ---------------------------------------------------------------------------

/**
 * The model that writes a call's summary from its transcript. Gemini text, the
 * same key and the same broker path as the call itself, on the free tier.
 */
export const VOICE_CALL_SUMMARY_MODEL = "gemini-3.1-flash-lite";
/** Tried when the primary summariser model is unavailable to this key. */
export const VOICE_CALL_SUMMARY_FALLBACK_MODEL = "gemini-flash-lite-latest";
/** At most this many bullets survive, however many the model returns. */
export const VOICE_CALL_SUMMARY_MAX_POINTS = 5;
/** Longest one bullet, the sentence, the decision or the open question may be. */
export const VOICE_CALL_SUMMARY_FIELD_CHARS = 300;
/**
 * How long after a failed summary the one retry runs, and how many times a
 * call is tried in total. A call that still fails shows its transcript alone:
 * the summary is a convenience and must never hold up or break a card.
 */
export const VOICE_CALL_SUMMARY_RETRY_MS = 60_000;
export const VOICE_CALL_SUMMARY_MAX_ATTEMPTS = 3;
/** Longest the summary's own block in a bot's turn context may get. */
export const VOICE_CALL_SUMMARY_CONTEXT_CHARS = 900;
/** How many past calls' summaries one turn context may carry. */
export const VOICE_CALL_SUMMARY_CONTEXT_CALLS = 2;

/**
 * What one call was about, written once from its transcript and the messages
 * the voice relayed during it. Every field is a short line the card can show
 * as it stands; `decision` and `open` are null when the call had neither.
 */
export const VoiceCallSummary = Schema.Struct({
  /** One sentence: what was asked and what came of it. */
  summary: TrimmedNonEmptyString,
  /** Up to five concrete facts (a court, a time, a price, a name). */
  points: Schema.Array(Schema.String),
  /** The owner's last decision on the call, or null when he made none. */
  decision: Schema.NullOr(Schema.String),
  /** Anything left undecided, or null when nothing was. */
  open: Schema.NullOr(Schema.String),
});
export type VoiceCallSummary = typeof VoiceCallSummary.Type;

// ---------------------------------------------------------------------------
// voice samples (Settings > Voice calls, spec section 8)
// ---------------------------------------------------------------------------

/**
 * The TTS model a sample is made with. Same generation as the call voice, so a
 * sample sounds like the voice he will actually get on a call.
 */
export const VOICE_CALL_SAMPLE_MODEL = "gemini-3.8-flash-tts";
/**
 * The one line every sample says. Fixed on purpose: the request must never
 * carry text from a page, a chat or the owner, so this endpoint can never be
 * turned into a free text-to-speech proxy.
 */
export const VOICE_CALL_SAMPLE_TEXT =
  "Hi, this is how I sound on a call. Anything you need, just say.";
/** The largest audio answer accepted: a four-second clip is about 200 KB. */
export const VOICE_CALL_SAMPLE_MAX_BYTES = 1_500_000;

export const VoiceCallSampleInput = Schema.Struct({
  /** Must be one of {@link VOICE_CALL_VOICES}: the allow-list, checked server-side. */
  voiceName: Schema.String,
});
export type VoiceCallSampleInput = typeof VoiceCallSampleInput.Type;

export const VoiceCallSampleResult = Schema.Struct({
  voiceName: Schema.String,
  /** "audio/wav": Google returns a complete WAV file. */
  mimeType: Schema.String,
  /** The clip itself, base64. Made once per voice, then served from the laptop. */
  base64: Schema.String,
  /** True when this answer came from the cache and no model call was made. */
  cached: Schema.Boolean,
});
export type VoiceCallSampleResult = typeof VoiceCallSampleResult.Type;

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
  /**
   * Whether the setup should include Google's own live Search. False while the
   * server remembers that Search is out of quota on this key (until the next
   * midnight Pacific); the call then declares the `search_web` tool instead and
   * the server answers searches itself.
   */
  googleSearch: Schema.Boolean,
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
 * - `sensitive_chat`: the chat has had a site the owner marked sensitive open.
 *   A call fails closed there and nothing from that chat is ever run through
 *   the voice: `start` and `send` refuse, and the snapshot returns no chat text.
 * - `send_failed`: the chat refused the message, so nothing was posted.
 * - `google_unavailable`: Google could not be reached, or answered 5xx.
 * - `rate_limited`: too many starts in a row from this client.
 * - `invalid_input`: a field the server cannot use.
 * - `not_found`: the chat or the call does not exist, or the call is not open
 *   any more (a stale tab, or a server restart mid-call).
 */
export const VoiceCallErrorCode = Schema.Literals([
  "no_key",
  "key_rejected",
  "key_quota",
  "calls_not_allowed",
  "not_owner_chat",
  "sensitive_chat",
  "send_failed",
  "google_unavailable",
  "rate_limited",
  "invalid_input",
  "sample_unavailable",
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
// renewPass (Google Search out of quota: reconnect without it)
// ---------------------------------------------------------------------------

/**
 * Why the client wants a fresh pass for a call it already has. Only one reason
 * exists today: the session closed with a quota error before the model said
 * anything, and its setup had included Google Search.
 */
export const VoiceCallRenewReason = Schema.Literals(["search_quota"]);
export type VoiceCallRenewReason = typeof VoiceCallRenewReason.Type;

export const VoiceCallRenewPassInput = Schema.Struct({
  threadId: ThreadId,
  callId: TrimmedNonEmptyString,
  reason: VoiceCallRenewReason,
});
export type VoiceCallRenewPassInput = typeof VoiceCallRenewPassInput.Type;

export const VoiceCallRenewPassResult = Schema.Struct({
  token: Schema.String,
  tokenExpiresAt: Schema.DateTimeUtcFromString,
  newSessionExpiresAt: Schema.DateTimeUtcFromString,
  /** Always false: the renewed session runs without Google's Search. */
  googleSearch: Schema.Boolean,
});
export type VoiceCallRenewPassResult = typeof VoiceCallRenewPassResult.Type;

// ---------------------------------------------------------------------------
// searchWeb (the voice's own search, when Google Search is not available)
// ---------------------------------------------------------------------------

/** At most this many results one voice search returns. */
export const VOICE_CALL_SEARCH_RESULTS_MAX = 4;
/** Per-field caps, so the whole reply stays well under 3 KB. */
export const VOICE_CALL_SEARCH_TITLE_CHARS = 120;
export const VOICE_CALL_SEARCH_SNIPPET_CHARS = 320;
export const VOICE_CALL_SEARCH_URL_CHARS = 200;
export const VOICE_CALL_SEARCH_QUERY_CHARS = 200;
/** The server gives the search this long before it answers "no results". */
export const VOICE_CALL_SEARCH_TIMEOUT_MS = 6_000;
/** Searches one call may run per minute. */
export const VOICE_CALL_SEARCHES_PER_MINUTE = 10;

/**
 * Longest query the phone may send. The server redacts secrets from it first and
 * only then cuts it to `VOICE_CALL_SEARCH_QUERY_CHARS`, so a secret cannot
 * straddle the cut; this bound only keeps the request itself small.
 */
export const VOICE_CALL_SEARCH_INPUT_CHARS = 2_000;

export const VoiceCallSearchWebInput = Schema.Struct({
  threadId: ThreadId,
  callId: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(VOICE_CALL_SEARCH_INPUT_CHARS)),
});
export type VoiceCallSearchWebInput = typeof VoiceCallSearchWebInput.Type;

export const VoiceCallSearchResult = Schema.Struct({
  title: Schema.String,
  snippet: Schema.String,
  url: Schema.String,
});
export type VoiceCallSearchResult = typeof VoiceCallSearchResult.Type;

export const VoiceCallSearchWebResult = Schema.Struct({
  results: Schema.Array(VoiceCallSearchResult),
  /**
   * Empty when results came back. Otherwise the reason there are none, said
   * plainly so the voice can repeat it instead of guessing.
   */
  note: Schema.String,
});
export type VoiceCallSearchWebResult = typeof VoiceCallSearchWebResult.Type;

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
  /**
   * The one-line summary of the call, written on the server after the card was
   * stored. Absent while it is still being written, or when it could not be:
   * the card then shows the transcript alone. Optional so a client built before
   * this feature still decodes a card.
   */
  summary: Schema.optional(VoiceCallSummary),
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
 *
 * Each row's `transcript` is **always empty here**: the list never reads the
 * stored transcripts, so opening a chat costs one small query whatever the call
 * history. The client fetches a card's transcript with
 * {@link VoiceCallTranscriptInput} when the owner expands it.
 */
export const VoiceCallListResult = Schema.Struct({
  calls: Schema.Array(VoiceCallRecord),
});
export type VoiceCallListResult = typeof VoiceCallListResult.Type;

// ---------------------------------------------------------------------------
// snapshot (a running call's own chat state)
// ---------------------------------------------------------------------------

/** Longest the reply the voice may read out is allowed to get, in characters. */
export const VOICE_CALL_SNAPSHOT_REPLY_CHARS = 4_000;

export const VoiceCallSnapshotInput = Schema.Struct({
  threadId: ThreadId,
  callId: TrimmedNonEmptyString,
});
export type VoiceCallSnapshotInput = typeof VoiceCallSnapshotInput.Type;

/**
 * The call's own chat, as of now, for the client's `bot_status` and
 * `latest_reply` tools.
 *
 * The server reads this **for the call's own thread**, never for whatever chat
 * happens to be on screen, so opening another chat mid-call cannot make the
 * voice read a stranger's reply or think a turn ended. Every text here is
 * redacted and bounded on the server; a chat that has had a site the owner
 * marked sensitive open returns the status only, with no chat text at all.
 */
export const VoiceCallSnapshotResult = Schema.Struct({
  /** "Working", "Idle" or "Waiting on you", in the app's own words. */
  status: Schema.String,
  /** The current step line while it works; redacted, empty when there is none. */
  stepNote: Schema.String,
  /** True while the bot's own turn is running. */
  turnRunning: Schema.Boolean,
  /** The newest finished reply in the call's chat; redacted, capped, may be "". */
  latestReply: Schema.String,
  /** The id of that reply, so the client only speaks each one once; "" when none. */
  latestReplyMessageId: Schema.String,
  /** When that reply landed; null when there is none. */
  latestReplyAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type VoiceCallSnapshotResult = typeof VoiceCallSnapshotResult.Type;

// ---------------------------------------------------------------------------
// transcript (fetched when a card is expanded)
// ---------------------------------------------------------------------------

/**
 * The call card's transcript, on its own request. The list deliberately does
 * not carry transcripts: a chat with fifty calls would otherwise send every
 * one of them on every chat open, voice on or off.
 */
export const VoiceCallTranscriptInput = Schema.Struct({
  callId: TrimmedNonEmptyString,
});
export type VoiceCallTranscriptInput = typeof VoiceCallTranscriptInput.Type;

export const VoiceCallTranscriptResult = Schema.Struct({
  callId: TrimmedNonEmptyString,
  transcript: Schema.Array(VoiceCallTranscriptEntry),
});
export type VoiceCallTranscriptResult = typeof VoiceCallTranscriptResult.Type;

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
