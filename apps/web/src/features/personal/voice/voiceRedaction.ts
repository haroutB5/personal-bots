/**
 * What the voice is allowed to hear.
 *
 * The client is not the place secrets are supposed to be stopped (the server
 * owns `redactSecrets` and refuses sensitive chats outright), but the browser
 * must never *forward* raw chat text to Google on its own account either. Every
 * string the engine hands the model from the chat or from memory goes through
 * `redactForVoice` first, and is capped, so a stray key in a bot's reply that
 * the server missed cannot be read out loud and cannot leave the laptop twice.
 *
 * The `latest_reply` and `bot_status` answers to the voice are the only places
 * raw chat text reaches the socket from here (send_to_bot carries what the
 * owner just said, and lookup_memory is already redacted server-side).
 *
 * @module features/personal/voice/voiceRedaction
 */

/** At most this many characters of a chat reply the voice is handed. */
export const VOICE_SPOKEN_MAX_CHARS = 1_200;

/** What a redacted value reads as. Never the value itself. */
export const VOICE_REDACTED = "[hidden]";

const PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly replace: string }> = [
  // The Gemini key itself, and the other shapes that show up in an hbots chat.
  { pattern: /\bAIza[0-9A-Za-z_-]{10,}/g, replace: VOICE_REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: VOICE_REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: VOICE_REDACTED },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: VOICE_REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: VOICE_REDACTED },
  // A JWT (three dot-separated base64url runs) is almost always a bearer token.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    replace: VOICE_REDACTED,
  },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: `Bearer ${VOICE_REDACTED}` },
  // "password: hunter2", "api_key = abc", "token=xyz". The separator is kept so
  // the sentence still reads as one.
  {
    pattern:
      /\b(password|passwd|passphrase|secret|api[ _-]?key|access[ _-]?token|auth[ _-]?token)\b(\s*[:=]\s*)["']?[^\s"',;]{3,}/gi,
    replace: `$1$2${VOICE_REDACTED}`,
  },
  // A payment card, in any of the usual groupings.
  { pattern: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, replace: VOICE_REDACTED },
  // A long opaque run: base64, hex, or a signed URL's own blob.
  { pattern: /\b[A-Za-z0-9+/=_-]{40,}\b/g, replace: VOICE_REDACTED },
];

/**
 * One string, safe to hand the model: secrets replaced, length capped. An
 * empty or whitespace-only string comes back as an empty string, because the
 * callers use "" to mean "nothing to say".
 */
export function redactForVoice(text: string | null | undefined): string {
  if (text === null || text === undefined) return "";
  let next = text;
  for (const { pattern, replace } of PATTERNS) next = next.replace(pattern, replace);
  if (next.length > VOICE_SPOKEN_MAX_CHARS) {
    next = `${next.slice(0, VOICE_SPOKEN_MAX_CHARS - 1).trimEnd()}…`;
  }
  return next;
}

/** True when redaction changed anything, for the tests and for diagnostics. */
export function containsRedactableSecret(text: string): boolean {
  return redactForVoice(text) !== text;
}
