/**
 * The one module that knows how the web app talks to the voice-call server.
 *
 * Backend owns `apps/server/**` and the contract (`feat/hbots-voice-calls`,
 * `packages/contracts/src/personalVoiceCalls.ts`). Every server call the UI
 * makes is named here, so the rest of the voice feature depends on these
 * helpers and never on a transport: swapping an RPC, changing a tag or moving
 * an endpoint is a change to this file alone.
 *
 * Nothing secret ever passes through the browser: the server mints a
 * short-lived single-use Live token per call and the client hands that to
 * Google. The Gemini API key is saved as an ordinary brokered key (name
 * `GEMINI_API_KEY`, origin `https://generativelanguage.googleapis.com`, header
 * `x-goog-api-key`), so the settings row writes it through the same secret
 * store the Passwords and API-keys screens use and never reads a value back.
 *
 * @module features/personal/voice/voiceCallApi
 */
import {
  type PersonalSecretSummary,
  type VoiceCallErrorCode,
  type VoiceCallFinishInput,
  type VoiceCallFinishResult,
  type VoiceCallKeyCheckResult,
  type VoiceCallLookupMemoryInput,
  type VoiceCallLookupMemoryResult,
  type VoiceCallMemoryEntry,
  type VoiceCallListInput,
  type VoiceCallListResult,
  type VoiceCallRecord,
  type VoiceCallRenewPassInput,
  type VoiceCallRenewPassResult,
  type VoiceCallSearchWebInput,
  type VoiceCallSearchWebResult,
  type VoiceCallSendInput,
  type VoiceCallSendResult,
  type VoiceCallSnapshotInput,
  type VoiceCallSnapshotResult,
  type VoiceCallTranscriptInput,
  type VoiceCallTranscriptResult,
  VOICE_CALL_QUIET_MINUTES,
  VOICE_CALL_SECRET_HEADER,
  VOICE_CALL_SECRET_NAME,
  VOICE_CALL_SECRET_ORIGIN,
  VOICE_CALL_VOICES,
  type VoiceCallSettings,
  type VoiceCallSettingsInput,
  type VoiceCallStartInput,
  type VoiceCallStartResult,
  type VoiceCallSummary,
  type VoiceCallTranscriptEntry,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../../../connection/runtime";

/** Opens a call and mints its Live token. */
export const personalVoiceCallStart = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-voice-calls:start",
  tag: WS_METHODS.personalVoiceCallsStart,
});

/** The chat's own call cards, newest first. Carries no transcript: see below. */
export const personalVoiceCallsList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-voice-calls:list",
  tag: WS_METHODS.personalVoiceCallsList,
  staleTimeMs: 10_000,
});

/**
 * One card's transcript, fetched when the owner expands it. `list` never reads
 * the stored transcripts, so opening a chat costs one small query whatever the
 * call history; this is the only thing that fetches a transcript.
 */
export const personalVoiceCallTranscript = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "personal-voice-calls:transcript",
    tag: WS_METHODS.personalVoiceCallsTranscript,
    staleTimeMs: 5 * 60_000,
  },
);

/**
 * The call's OWN chat while a call is running: the bot's status, whether its
 * turn is running, and the newest finished reply (redacted and capped on the
 * server). `bot_status`, `latest_reply` and the turn end all read this, so the
 * voice can never see whatever chat happens to be on screen.
 *
 * A command, not a query: the call polls it once a second and wants the answer
 * as of now, never a cached one.
 */
export const personalVoiceCallSnapshot = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-voice-calls:snapshot",
  tag: WS_METHODS.personalVoiceCallsSnapshot,
});

/** Posts one utterance as the owner's message in the call's chat. */
export const personalVoiceCallSend = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-voice-calls:send",
  tag: WS_METHODS.personalVoiceCallsSend,
});

/** Stores the one call card the chat keeps. */
export const personalVoiceCallFinish = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-voice-calls:finish",
  tag: WS_METHODS.personalVoiceCallsFinish,
  // A finished call's card must appear without navigating away and back: the
  // chat's list query is refreshed as soon as the card is stored (finding 7).
  onSuccess: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(
        personalVoiceCallsList({
          environmentId: target.environmentId,
          input: finishedCallListInput(target.input),
        }),
      ),
    ),
});

/**
 * The list query a stored card refreshes: the CHAT's card list, keyed by
 * `{ threadId }` exactly as every screen reads it. The whole `finish` input
 * would key a different atom, so the refresh landed on a query nothing reads
 * and the new card only appeared after a reload (QA bug 3).
 */
export function finishedCallListInput(input: VoiceCallFinishInput): VoiceCallListInput {
  return { threadId: input.threadId };
}

/** Proves the saved key can open a Live session (no audio billed). */
export const personalVoiceCallCheckKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-voice-calls:check-key",
  tag: WS_METHODS.personalVoiceCallsCheckKey,
});

/** The voice's own fast facts: the owner's saved notes, read out on a call. */
export const personalVoiceCallLookupMemory = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-voice-calls:lookup-memory",
  tag: WS_METHODS.personalVoiceCallsLookupMemory,
});

/**
 * A fresh pass for a call that is already open, after Google's own Search ran
 * out of quota. The server remembers it for later calls.
 */
export const personalVoiceCallRenewPass = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-voice-calls:renew-pass",
  tag: WS_METHODS.personalVoiceCallsRenewPass,
});

/** The voice's own web search, used when the session has no Google Search. */
export const personalVoiceCallSearchWeb = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-voice-calls:search-web",
  tag: WS_METHODS.personalVoiceCallsSearchWeb,
});

export type {
  VoiceCallErrorCode,
  VoiceCallRenewPassInput,
  VoiceCallRenewPassResult,
  VoiceCallSearchWebInput,
  VoiceCallSearchWebResult,
  VoiceCallLookupMemoryInput,
  VoiceCallLookupMemoryResult,
  VoiceCallMemoryEntry,
  VoiceCallFinishInput,
  VoiceCallFinishResult,
  VoiceCallKeyCheckResult,
  VoiceCallListResult,
  VoiceCallRecord,
  VoiceCallSendInput,
  VoiceCallSendResult,
  VoiceCallSettings,
  VoiceCallSettingsInput,
  VoiceCallSnapshotInput,
  VoiceCallSnapshotResult,
  VoiceCallStartInput,
  VoiceCallStartResult,
  VoiceCallSummary,
  VoiceCallTranscriptEntry,
  VoiceCallTranscriptInput,
  VoiceCallTranscriptResult,
};

export {
  VOICE_CALL_QUIET_MINUTES,
  VOICE_CALL_SECRET_HEADER,
  VOICE_CALL_SECRET_NAME,
  VOICE_CALL_SECRET_ORIGIN,
  VOICE_CALL_VOICES,
};

/** What one call's session is, in the engine's own words. */
export type VoiceCallSession = VoiceCallStartResult;

/** Result of one command atom, as `useAtomCommand` resolves it. */
export interface AtomCommandResult<T> {
  readonly _tag: string;
  readonly value?: T;
  readonly error?: unknown;
}

/**
 * Every failure code the call screen can render. The set below is written out
 * so a code the contract adds is only ever named in one place, and so an older
 * client still recognises it if the server gets ahead.
 */
export type VoiceCallAnyErrorCode = VoiceCallErrorCode;

const VOICE_CALL_ERROR_CODES: ReadonlySet<string> = new Set([
  "no_key",
  "key_rejected",
  "key_quota",
  "calls_not_allowed",
  "not_owner_chat",
  // A chat that has had a private site open: the server refuses the call
  // outright rather than sending its messages to Google (review finding 1).
  "sensitive_chat",
  // The chat refused the message, so nothing was posted (must-fix 2).
  "send_failed",
  "google_unavailable",
  "rate_limited",
  "invalid_input",
  "not_found",
]);

export function isVoiceCallErrorCode(value: unknown): value is VoiceCallAnyErrorCode {
  return typeof value === "string" && VOICE_CALL_ERROR_CODES.has(value);
}

/**
 * Digs the typed code out of an RPC failure. Backend's error is an Effect
 * tagged error (`PersonalVoiceCallsError`) carrying `code`; a transport failure
 * has no code at all, which reads as `google_unavailable` because that is the
 * one the call screen can offer a fix for ("try again").
 */
export function voiceCallFailureCode(failure: unknown): VoiceCallAnyErrorCode {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): VoiceCallAnyErrorCode | null => {
    if (depth > 6 || value === null || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    // The RPC client hands the screen an AsyncResult failure whose Cause holds
    // the typed error in `reasons[]`. The old walk never entered an array, so
    // every code (no_key, key_rejected, key_quota, sensitive_chat, not_found)
    // read as an unreachable Google (QA bug 1).
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = walk(entry, depth + 1);
        if (found !== null) return found;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    const code = record.code ?? record.errorCode;
    if (isVoiceCallErrorCode(code)) return code;
    for (const key of ["error", "cause", "failure", "reason", "reasons", "value"]) {
      const found = walk(record[key], depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(failure, 0) ?? "google_unavailable";
}

/** A short line for the failure, never the raw object. */
export function voiceFailureDetail(failure: unknown): string {
  if (typeof failure === "string") return failure.slice(0, 200);
  if (typeof failure !== "object" || failure === null) return "";
  const record = failure as Record<string, unknown>;
  const message = record.message ?? record.detail;
  return typeof message === "string" ? message.slice(0, 200) : "";
}

/** True when the saved Gemini key exists in the secret store. */
export function hasVoiceCallKey(
  secrets: ReadonlyArray<PersonalSecretSummary> | null | undefined,
): boolean {
  return voiceCallKeySecret(secrets) !== null;
}

/** The secret store entry the Gemini key row shows the state of, or null. */
export function voiceCallKeySecret(
  secrets: ReadonlyArray<PersonalSecretSummary> | null | undefined,
): PersonalSecretSummary | null {
  return (secrets ?? []).find((secret) => secret.name === VOICE_CALL_SECRET_NAME) ?? null;
}

/** The origin the key is bound to, printed in the row's own words. */
export const VOICE_CALL_KEY_ORIGIN_LABEL = "generativelanguage.googleapis.com";

/** Keys come from Google AI Studio. One literal, used by every surface. */
export const GEMINI_KEYS_URL = "https://aistudio.google.com/apikey";
export const GEMINI_KEYS_URL_LABEL = "aistudio.google.com";

/** The extra header placement a brokered Gemini key needs. */
export const VOICE_CALL_KEY_PLACEMENT = { header: VOICE_CALL_SECRET_HEADER } as const;

/** One of Gemini's voices, as the picker offers it. */
export interface VoiceChoice {
  readonly name: string;
  readonly note: string | null;
}

/** The eight curated voices, in the order the sheet shows them (spec 8). */
export const CURATED_VOICES: ReadonlyArray<VoiceChoice> = [
  { name: "Charon", note: "Informative · Default" },
  { name: "Kore", note: "Firm" },
  { name: "Puck", note: "Upbeat" },
  { name: "Aoede", note: "Breezy" },
  { name: "Sulafat", note: "Warm" },
  { name: "Iapetus", note: "Clear" },
  { name: "Achird", note: "Friendly" },
  { name: "Sadaltager", note: "Knowledgeable" },
];

/** The curated names, so "more voices" never repeats one. */
const CURATED_NAMES: ReadonlySet<string> = new Set(CURATED_VOICES.map((voice) => voice.name));

/** The rest of the voice list, straight from the contract, behind "More voices". */
export const MORE_VOICES: ReadonlyArray<string> = VOICE_CALL_VOICES.filter(
  (name) => !CURATED_NAMES.has(name),
);

export type VoiceCallCheckTone = "pending" | "ok" | "rejected" | "empty" | "quiet";

export interface VoiceCallCheck {
  readonly tone: VoiceCallCheckTone;
  readonly text: string;
}

/**
 * The line under the key after a save, reusing the DeepSeek row's vocabulary.
 * `missing` and `unavailable` are never called a bad key: the first means the
 * server has no key, the second means the check could not run.
 */
export function voiceApiKeyCheckLine(result: VoiceCallKeyCheckResult | null): VoiceCallCheck {
  if (result === null) return { tone: "pending", text: "Checking this key…" };
  switch (result.status) {
    case "ok":
      return { tone: "ok", text: "Key works" };
    case "quota":
      return { tone: "empty", text: "Key works, but Gemini says it's out of quota" };
    case "rejected":
      return { tone: "rejected", text: "Google didn't accept this key" };
    case "missing":
      return { tone: "quiet", text: "No key is saved yet" };
    default:
      return { tone: "quiet", text: "Could not check the key right now" };
  }
}
