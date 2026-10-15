/**
 * The call's own state, as pure data: every state the screen and the bar draw,
 * the copy for each one, and the clock rules that end a call. No React, no
 * audio, no network, so all of it is unit-testable and the screen stays a
 * renderer.
 *
 * Copy rules (harout's decisions, 15 Oct):
 * - The voice speaks AS the bot, in the first person. Captions are labelled
 *   with the bot's name ("CTO"), never the word "Voice".
 * - Nothing reads as if a middle bot were relaying. The Undo card says
 *   "Asking CTO to:" and the send is described as the owner's own message.
 * - Free tier at launch: the call card carries duration only, no cost line.
 *
 * @module features/personal/voice/callState
 */
import type { VoiceCallAnyErrorCode } from "./voiceCallApi";

/**
 * A failure code the call screen can render. The server's own codes come from
 * the contract; "unknown" is a local failure (the microphone, usually) that
 * never reached the laptop at all.
 */
export type VoiceCallUiErrorCode = VoiceCallAnyErrorCode | "unknown";

/** The work card: what the real bot is doing for the voice. */
export type VoiceWorkKind = "sending" | "working" | "replied" | "asking" | "login";

/**
 * The pill: what the line is doing right now. The last two are the fast tools
 * the voice runs without the bot: its own memory lookup and Google's built-in
 * Search. Both show as a pill and nothing else, because neither posts anything
 * into the chat.
 */
export type VoicePill =
  | "listening"
  | "speaking"
  | "reading"
  | "muted"
  | "reconnecting"
  /** Reading the owner's own saved notes (lookup_memory). */
  | "checking_memory"
  /** Google Search is grounding an answer about a public fact. */
  | "searching"
  | "none";

export interface VoicePendingSend {
  /** The exact text the voice wants to send. */
  readonly text: string;
  readonly atMs: number;
  /** When the Undo window closes and the message goes. */
  readonly dueAtMs: number;
  /** "Sending" while the window runs, "cancelled" once the owner undid it. */
  readonly cancelled: boolean;
}

export interface VoiceWorkCard {
  readonly kind: VoiceWorkKind;
  readonly title: string;
  readonly detail: string;
  /** Live elapsed for the working card, ms since the send. */
  readonly sinceMs: number | null;
}

export interface VoiceTranscriptLine {
  readonly atMs: number;
  readonly speaker: "you" | "voice" | "event";
  readonly text: string;
}

/**
 * Every way a call ends (spec 5). Each one is written to `finish()` exactly
 * once, with the reason, so the chat card can say how it ended.
 */
export type VoiceEndReason =
  | "hung_up"
  | "said_bye"
  | "quiet"
  | "waiting_cap"
  | "left_app"
  | "interrupted"
  | "limit"
  | "dropped"
  | "failed";

export const VOICE_END_REASONS: ReadonlyArray<VoiceEndReason> = [
  "hung_up",
  "said_bye",
  "quiet",
  "waiting_cap",
  "left_app",
  "interrupted",
  "limit",
  "dropped",
  "failed",
];

/** How long the Undo window stays open after a send_to_bot tool call. */
export const VOICE_UNDO_MS = 3_000;

/**
 * How many sends may be held at once. A second `send_to_bot` while one is held
 * queues behind it instead of posting the first one early (the review's
 * finding 3); a fourth is refused with `one_at_a_time` rather than growing
 * without bound.
 */
export const VOICE_SEND_QUEUE_MAX = 3;

/**
 * How long a sent message may wait for the bot's turn to end before the voice
 * is told about the send on its own. The bot's turn usually starts within this
 * window; when it does, the reply is handed over at the real turn end instead.
 */
export const VOICE_REPLY_GRACE_MS = 1_500;

/**
 * The hard cap on reaching a live session. Past this the call is over as
 * `google_unavailable`, whatever the socket is still doing (spec 3.2).
 */
export const VOICE_CONNECT_TIMEOUT_MS = 20_000;

/** Delay before each `finish` retry, then never again. One call, one card. */
export const VOICE_FINISH_RETRY_MS: ReadonlyArray<number> = [
  1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
];

/** No speech either way, nothing pending: the quiet timer's warning lead. */
export const VOICE_QUIET_WARNING_MS = 15_000;

/** While a send is pending, quiet waiting is capped at this. */
export const VOICE_WAITING_CAP_MS = 5 * 60_000;

/** A reconnect taking longer than this shows the Reconnecting state at all. */
export const VOICE_RECONNECT_HIDDEN_MS = 1_500;

/** Give up on a reconnect after this and end the call as dropped. */
export const VOICE_RECONNECT_GIVE_UP_MS = 15_000;

/**
 * The line when the server has forgotten the call entirely (`not_found`: the
 * laptop restarted and its in-memory lease is gone). The ended screen says this
 * instead of "The call dropped", which would send the owner looking at their
 * connection.
 */
export const VOICE_CALL_LOST_LINE = "The laptop restarted, so this call ended.";

/** The hard cap, and where it warns and says goodbye (fractions of it). */
export const VOICE_LIMIT_WARN_FRACTION = 28 / 30;
export const VOICE_LIMIT_BYE_FRACTION = 29.75 / 30;

export type VoiceCallStatus = "connecting" | "live" | "reconnecting" | "ended" | "error";

export interface VoiceCallState {
  readonly status: VoiceCallStatus;
  readonly pill: VoicePill;
  readonly muted: boolean;
  readonly captionsOn: boolean;
  /** Where the stage's ring reads its level from; never a React render itself. */
  readonly level: number;
  readonly pending: VoicePendingSend | null;
  readonly work: VoiceWorkCard | null;
  readonly caption: { readonly who: "you" | "voice"; readonly text: string } | null;
  /** The hint line that fills the caption box when there is no live caption. */
  readonly hint: string | null;
  readonly errorCode: VoiceCallUiErrorCode | null;
  readonly endReason: VoiceEndReason | null;
  /** True once the "2 min left on this call" banner should show. */
  readonly nearLimit: boolean;
  /** Set while the voice is telling the owner it is about to hang up on quiet. */
  readonly quietWarning: boolean;
}

export const INITIAL_VOICE_CALL_STATE: VoiceCallState = {
  status: "connecting",
  pill: "none",
  muted: false,
  captionsOn: true,
  level: 0,
  pending: null,
  work: null,
  caption: null,
  hint: null,
  errorCode: null,
  endReason: null,
  nearLimit: false,
  quietWarning: false,
};

/** "2:14". Duration only; a call is capped at 30 minutes so hours never appear. */
export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The line under the bot's name: "Calling…", "Voice call · 2:14",
 * "Call ended · 4:12", or the dropped form once a call had connected.
 */
export function callMetaLine(input: {
  readonly status: VoiceCallStatus;
  readonly elapsedMs: number;
  /** True once the session was ever live: a drop names the time, a refusal does not. */
  readonly everConnected: boolean;
}): string {
  if (input.status === "connecting") return "Calling…";
  if (input.status === "ended") return `Call ended · ${formatCallDuration(input.elapsedMs)}`;
  if (input.status === "error") {
    return input.everConnected
      ? `Call dropped · ${formatCallDuration(input.elapsedMs)}`
      : "Can't start the call";
  }
  return `Voice call · ${formatCallDuration(input.elapsedMs)}`;
}

/** The sentence the ended screen and the call card both print. */
export function endReasonLine(reason: VoiceEndReason, quietMinutes: number): string {
  switch (reason) {
    case "hung_up":
      return "You hung up.";
    case "said_bye":
      return "Ended when you said bye.";
    case "quiet":
      return `Ended after ${quietMinutes} quiet ${quietMinutes === 1 ? "minute" : "minutes"}.`;
    case "waiting_cap":
      return "Ended while the bot works. The reply will come here.";
    case "left_app":
      return "Ended when you left the app.";
    case "interrupted":
      return "Ended by another call.";
    case "limit":
      return "Ended at the 30-minute limit.";
    case "dropped":
      return "The call dropped.";
    case "failed":
      return "The call never connected.";
  }
}

/** The pill's own words (spec 12). */
export function pillLabel(pill: VoicePill, botName: string): string {
  switch (pill) {
    case "listening":
      return "Listening";
    case "speaking":
      return "Speaking";
    case "reading":
      return `Reading ${botName}'s reply`;
    case "muted":
      return "Muted";
    case "reconnecting":
      return "Reconnecting";
    case "checking_memory":
      return "Checking memory";
    case "searching":
      return "Searching";
    case "none":
      return "";
  }
}

/**
 * The hint that takes the caption box when there is no live caption (spec 3.2).
 * `waitingMs` is how long the call has been trying to connect.
 */
export function callHint(input: {
  readonly state: VoiceCallState;
  readonly waitingMs: number;
}): string | null {
  const { state } = input;
  if (state.status === "connecting") {
    if (input.waitingMs >= 8_000) return "Still connecting…";
    if (input.waitingMs >= 400) return "Allow the microphone when your iPhone asks.";
    return null;
  }
  if (state.pill === "muted") {
    return "The voice can't hear you. It still tells you when the bot replies.";
  }
  if (state.pill === "checking_memory") {
    return "Reading your own saved notes. Nothing goes into the chat.";
  }
  if (state.pill === "searching") {
    return "Looking that up. Nothing goes into the chat.";
  }
  if (state.status === "reconnecting") {
    return "Hold on, the line is reconnecting. Nothing you said is lost.";
  }
  if (state.status === "ended" || state.status === "error") return null;
  return null;
}

/**
 * The Undo card, worded for a voice that speaks as the bot itself: the send is
 * the owner's own message, so the card says what is being asked, not that some
 * middle bot is relaying it. Short enough for one line at 390 px.
 */
export function pendingSendTitle(botName: string): string {
  return `Asking ${botName} to:`;
}

/** What the voice says while the Undo window is open. */
export function pendingSendSpokenLine(botName: string): string {
  return `Sending that to ${botName}.`;
}

/**
 * The owner's own short way of taking a send back ("no, wait"), matched on the
 * whole utterance so "stop the deploy" is never read as "stop".
 */
const CANCEL_PHRASES: ReadonlySet<string> = new Set([
  "no",
  "no wait",
  "no no",
  "no no wait",
  "wait",
  "wait wait",
  "hold on",
  "cancel",
  "cancel that",
  "cancel it",
  "stop",
  "undo",
  "undo that",
  "never mind",
  "nevermind",
  "don't",
  "dont",
  "don't send it",
  "dont send it",
  "don't send that",
  "dont send that",
]);

/** True when what the owner just said means "take that back". */
export function isVoiceCancelPhrase(text: string): boolean {
  const plain = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return CANCEL_PHRASES.has(plain);
}

/** What the voice says when it is about to hang up on a quiet line (spec 5). */
export const VOICE_QUIET_SPOKEN_LINE = "Still there?";

/** What the voice says at 29:45, before the 30-minute cap ends the call (spec 5). */
export const VOICE_GOODBYE_SPOKEN_LINE =
  "I have to go, we've hit the 30 minute limit on this call. Bye.";

/**
 * A line the client wants the voice to say out loud. Gemini Live has no
 * "speak this" frame, so the words ride in as a client turn wrapped in an
 * instruction that keeps the model from treating it as the owner speaking.
 */
export function spokenInstruction(text: string): string {
  return `System note from the app, not from Harout. Say this out loud now, in your own voice, and nothing else: "${text}"`;
}

/** The caption label for the voice: the bot's own name. */
export function voiceCaptionLabel(botName: string): string {
  return botName;
}

/**
 * How long a call has been quiet for the quiet timer to run out. Speech either
 * way, a pending send or a live bot turn all reset it (spec 5).
 */
export interface QuietClockInput {
  readonly nowMs: number;
  readonly lastSpeechAtMs: number;
  readonly quietMinutes: number;
  readonly pendingSend: boolean;
}

export function quietDeadlineMs(input: QuietClockInput): number {
  return input.lastSpeechAtMs + input.quietMinutes * 60_000;
}

export function quietWarningAtMs(input: QuietClockInput): number {
  return quietDeadlineMs(input) - VOICE_QUIET_WARNING_MS;
}

/** True when the quiet timer is up. Never fires while a send is pending. */
export function quietExpired(input: QuietClockInput): boolean {
  if (input.pendingSend) return false;
  return input.nowMs >= quietDeadlineMs(input);
}

/** True when the warning line is due and not yet spoken. */
export function quietWarningDue(input: QuietClockInput & { readonly warned: boolean }): boolean {
  if (input.pendingSend || input.warned) return false;
  return input.nowMs >= quietWarningAtMs(input) && input.nowMs < quietDeadlineMs(input);
}

/** The 28-minute banner and the 29:45 goodbye, from the session's own cap. */
export function limitPointsMs(maxCallMinutes: number): {
  readonly warnAtMs: number;
  readonly byeAtMs: number;
  readonly endAtMs: number;
} {
  const total = Math.max(1, maxCallMinutes) * 60_000;
  return {
    warnAtMs: Math.round(total * VOICE_LIMIT_WARN_FRACTION),
    byeAtMs: Math.round(total * VOICE_LIMIT_BYE_FRACTION),
    endAtMs: total,
  };
}

/** "2 min left on this call" (the banner pill). */
export function limitBannerText(maxCallMinutes: number): string {
  const left = Math.max(0, maxCallMinutes - Math.round(maxCallMinutes * VOICE_LIMIT_WARN_FRACTION));
  const minutes = left <= 1 ? 1 : left;
  return `${minutes} min left on this call`;
}

/**
 * One caption line, newest last, clipped to the box the spec gives it (3 lines)
 * and to the newest 40 rows so a long call cannot grow the transcript forever.
 */
export function appendCaption(
  lines: ReadonlyArray<VoiceTranscriptLine>,
  line: VoiceTranscriptLine,
): VoiceTranscriptLine[] {
  const next = [...lines, line];
  return next.length > 40 ? next.slice(next.length - 40) : next;
}

/* ---------------------------------------------------------------- colour */

/** `#aabbcc` as [r, g, b] 0-255, or null when the value is not a hex colour. */
export function parseHexColour(value: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) return null;
  const int = Number.parseInt(match[1]!, 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(value: string): number | null {
  const rgb = parseHexColour(value);
  if (rgb === null) return null;
  return (
    0.2126 * channelLuminance(rgb[0]) +
    0.7152 * channelLuminance(rgb[1]) +
    0.0722 * channelLuminance(rgb[2])
  );
}

/** WCAG contrast ratio between two hex colours; null when either is unreadable. */
export function contrastRatio(left: string, right: string): number | null {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  if (a === null || b === null) return null;
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * A bot colour that reads on the call's background. A colour under 3:1 (Fable's
 * purple is about 2.7:1) is mixed with white in 10 % steps until it clears the
 * bar; the avatar keeps the bot's own colour (spec 3.3).
 */
export function liftForContrast(
  colour: string,
  background: string,
  minimum = 3,
  mixTarget = "#ffffff",
): string {
  if (contrastRatio(colour, background) === null) return colour;
  if ((contrastRatio(colour, background) ?? 0) >= minimum) return colour;
  const from = parseHexColour(colour);
  const to = parseHexColour(mixTarget);
  if (from === null || to === null) return colour;
  for (let step = 1; step <= 10; step += 1) {
    const ratio = step / 10;
    const mixed = `#${from
      .map((channel, index) =>
        Math.round(channel + (to[index]! - channel) * ratio)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
    if ((contrastRatio(mixed, background) ?? 0) >= minimum) return mixed;
  }
  return mixTarget;
}
