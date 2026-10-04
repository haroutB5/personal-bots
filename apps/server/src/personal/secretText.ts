/**
 * Credential detection shared by memory and the task work record: neither ever
 * stores a secret (the secret store is the only place for those). Kept apart
 * from the memory service so the task service can use it without importing it.
 */

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:password|passwd|passcode|pwd|pin code|secret|api[_ -]?key|access[_ -]?key|auth[_ -]?token|token|bearer|private[_ -]?key|client[_ -]?secret)\b\s*(?:is|=|:)\s*\S+/i,
];

/**
 * `lenient` is for text that is mostly links, paths and commit ids (a task's
 * work record): the long-token rule then leaves alone a pure hex token of 40
 * characters (a commit id), anything inside an http(s) link, and a path (four
 * or more short segments; a 40 or 64-hex part counts as short). A bare 64-hex
 * token stays a key: it can be an HMAC or webhook secret. The named credential formats
 * (private keys, sk-, ghp_, xox, AKIA, JWTs, "password: ...") still apply.
 * Memory stays strict.
 */
export interface SecretCheckOptions {
  readonly lenient?: boolean | undefined;
}

const LONG_TOKEN = /[A-Za-z0-9+/_=-]{40,}/g;
const URL_SPAN = /https?:\/\/[^\s)>\]"'`]+/g;
const HEX_40 = /^[0-9a-fA-F]{40}$/;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

/** Whether a long token reads as a key (letters and digits mixed), given the exemptions of `lenient`. */
function readsAsKey(
  token: string,
  offset: number,
  urls: ReadonlyArray<readonly [number, number]>,
  lenient: boolean,
): boolean {
  if (!(/[A-Za-z]/.test(token) && /\d/.test(token))) return false;
  if (!lenient) return true;
  // A commit id (40 hex) is not a secret anywhere.
  if (HEX_40.test(token)) return false;
  if (urls.some(([from, to]) => offset >= from && offset < to)) return false;
  // A bare 64-hex token is as likely a 32-byte HMAC or webhook secret as a sha256: it is
  // let through only inside a link (above) or as a part of a path (below).
  if (HEX_64.test(token)) return true;
  const segments = token.split("/");
  return !(
    segments.length >= 4 &&
    segments.every(
      (segment) => segment.length <= 32 || HEX_40.test(segment) || HEX_64.test(segment),
    )
  );
}

const urlSpans = (text: string): ReadonlyArray<readonly [number, number]> =>
  [...text.matchAll(URL_SPAN)].map(
    (match) => [match.index, match.index + match[0].length] as const,
  );

/**
 * The text with anything credential-shaped replaced by "[redacted]": for
 * reasons, errors and file names the app stores or shows beside memory.
 */
export function redactSecrets(text: string, options: SecretCheckOptions = {}): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(
      new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`),
      "[redacted]",
    );
  }
  const urls = options.lenient === true ? urlSpans(out) : [];
  return out.replace(LONG_TOKEN, (token, offset: number) =>
    readsAsKey(token, offset, urls, options.lenient === true) ? "[redacted]" : token,
  );
}

/**
 * True when text looks like it carries a credential. Memory never stores
 * secrets: the secret store is the only place for those.
 */
export function looksLikeSecret(text: string, options: SecretCheckOptions = {}): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  // A long unbroken token mixing letters and digits reads as a key.
  const lenient = options.lenient === true;
  const urls = lenient ? urlSpans(text) : [];
  for (const match of text.matchAll(LONG_TOKEN)) {
    if (readsAsKey(match[0], match.index, urls, lenient)) return true;
  }
  return false;
}
