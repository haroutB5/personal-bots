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
 * The text with anything credential-shaped replaced by "[redacted]": for
 * reasons, errors and file names the app stores or shows beside memory.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(
      new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`),
      "[redacted]",
    );
  }
  return out.replace(/[A-Za-z0-9+/_=-]{40,}/g, (token) =>
    /[A-Za-z]/.test(token) && /\d/.test(token) ? "[redacted]" : token,
  );
}

/**
 * True when text looks like it carries a credential. Memory never stores
 * secrets: the secret store is the only place for those.
 */
export function looksLikeSecret(text: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  // A long unbroken token mixing letters and digits reads as a key.
  for (const token of text.match(/[A-Za-z0-9+/_=-]{40,}/g) ?? []) {
    if (/[A-Za-z]/.test(token) && /\d/.test(token)) return true;
  }
  return false;
}
