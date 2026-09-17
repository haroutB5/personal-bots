/**
 * One reading of why a turn failed, shared by the chat (which turns it into a
 * sentence the owner can act on) and the server (which decides whether trying
 * the same turn again could possibly help).
 *
 * Both sides must agree: a kind the chat calls "usage limit" and the server
 * calls "transient" would spend real model tokens re-running a turn the
 * provider has already refused. The patterns therefore live here once.
 */
export type TurnFailureKind =
  /** The account is out of allowance, or the provider is rate limiting it. */
  | "usage_limit"
  /** The provider is not signed in, or the credential was rejected. */
  | "signin"
  /** The provider understood the request and refused it (bad model, bad shape). */
  | "invalid_request"
  /** The provider session is gone; a new one has to be started. */
  | "session_closed"
  /** The owner stopped the turn. */
  | "interrupted"
  /** The provider's own service failed or was unreachable (5xx, bad gateway). */
  | "upstream"
  /** The turn ran past a deadline. */
  | "timeout"
  /** The connection to the provider broke. */
  | "network"
  /** Nothing recognised it. */
  | "unknown";

/**
 * Checked in order: the first match wins. A rate-limit body that also mentions
 * a gateway must read as a usage limit, never as a transient upstream blip, so
 * every "never retry" kind is tested before every transient one.
 */
const PATTERNS: ReadonlyArray<readonly [TurnFailureKind, RegExp]> = [
  [
    "usage_limit",
    /session limit|usage limit|rate[_ ]limit|\b429\b|hit your .*limit|quota exceeded|insufficient (?:credit|quota)|too many requests/,
  ],
  [
    "signin",
    /not (?:logged|signed) in|unauthori[sz]ed|\b401\b|\b403\b|authentication (?:failed|required)|please run \/login|invalid api key|(?:token|credential)s? (?:expired|invalid)/,
  ],
  [
    "invalid_request",
    /model not found|unknown model|no such model|bad request|invalid request|invalid_request_error|unsupported (?:model|parameter|request)/,
  ],
  ["session_closed", /thread is closed|sessionclosed|session (?:was )?(?:closed|stopped)/],
  [
    "interrupted",
    /aborted by (?:the )?user|interrupted by (?:the )?user|cancell?ed by (?:the )?user|user cancell?ed/,
  ],
  [
    "upstream",
    /upstream request failed|endpoint is unavailable|\b(?:500|502|503|504|520|521|522|524|529)\b|bad gateway|service unavailable|gateway time ?out|internal server error|overloaded|server error/,
  ],
  ["timeout", /timed? ?out|etimedout|deadline exceeded/],
  [
    "network",
    /enotfound|econnrefused|econnreset|epipe|socket hang ?up|fetch failed|network error|connection (?:reset|closed|refused|aborted)|dns lookup/,
  ],
];

/** Reads a provider's raw failure text as one kind. Case-insensitive. */
export function classifyTurnFailure(raw: string): TurnFailureKind {
  const text = raw.toLowerCase();
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return "unknown";
}

/**
 * Kinds where running the very same turn again has a real chance of working:
 * the provider's service, or the path to it, broke mid-flight.
 *
 * Deliberately excludes "unknown". An unrecognised failure is far more likely
 * to be a refusal we have not seen yet than a blip, and the cost of guessing
 * wrong is a second billed run of a long turn.
 */
const TRANSIENT: ReadonlySet<TurnFailureKind> = new Set<TurnFailureKind>([
  "upstream",
  "timeout",
  "network",
]);

export function isTransientTurnFailureKind(kind: TurnFailureKind): boolean {
  return TRANSIENT.has(kind);
}

/** True when the failure text describes a transient fault worth retrying. */
export function isTransientTurnFailure(raw: string): boolean {
  return isTransientTurnFailureKind(classifyTurnFailure(raw));
}
