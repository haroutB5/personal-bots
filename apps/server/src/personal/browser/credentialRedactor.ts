/**
 * Masks saved-login passwords wherever the shared browser hands text to a bot,
 * the activity feed or a log.
 *
 * The structural rails are what keep a password away from the model: it is
 * filled through an element handle, page scripts are refused after a fill, and
 * the credential tab is closed to reads. This is the belt on top of them. It
 * learns each password the moment `fillLogin` is about to type it and masks
 * it, and the spellings a page commonly turns it into, in every string that
 * leaves the browser service afterwards: a site that echoes the value into
 * page text, the console or a GET URL.
 *
 * It is not a boundary. An encoding it does not know (base64, a hash, a
 * character-by-character render) passes through, which is why nothing relies
 * on it alone. Values live in process memory only, the same place the server
 * already holds them while it fills.
 */

export const REDACTED_CREDENTIAL = "[saved password hidden]";

/** Shorter values would mask ordinary words; such a password is not worth hiding this way. */
const MIN_REDACTED_LENGTH = 4;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The spellings a page or a URL commonly turns a typed value into. */
const variantsOf = (value: string): ReadonlyArray<string> => {
  const variants = new Set<string>([value]);
  variants.add(encodeURIComponent(value));
  // application/x-www-form-urlencoded, which is how a GET login form sends it.
  variants.add(encodeURIComponent(value).replace(/%20/g, "+"));
  variants.add(encodeURI(value));
  // HTML-escaped, as page text sometimes carries it.
  variants.add(
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"),
  );
  return [...variants].filter((variant) => variant.length >= MIN_REDACTED_LENGTH);
};

export interface CredentialRedactor {
  /** Starts masking `value` in everything redacted from now on. */
  readonly remember: (value: string) => void;
  readonly redactText: (text: string) => string;
  /**
   * A structurally identical copy with every string masked. A snapshot's
   * base64 PNG passes through: it cannot contain the text, and scanning
   * megabytes of it would cost every snapshot.
   */
  readonly redact: <A>(value: A) => A;
}

/** `{ mimeType: "image/...", data: "<base64>" }`, the snapshot screenshot shape. */
const isImagePayload = (value: object): boolean => {
  const record = value as { readonly mimeType?: unknown; readonly data?: unknown };
  return (
    typeof record.mimeType === "string" &&
    record.mimeType.startsWith("image/") &&
    typeof record.data === "string"
  );
};

export function makeCredentialRedactor(): CredentialRedactor {
  const secrets = new Set<string>();
  let pattern: RegExp | null = null;

  const rebuild = () => {
    const alternatives = [...secrets]
      .flatMap(variantsOf)
      // Longest first, so an encoded spelling is replaced whole rather than
      // leaving the tail of it behind after the raw value matched inside it.
      .toSorted((left, right) => right.length - left.length)
      .map(escapeRegExp);
    // Case-insensitive: CSS text-transform and upper-cased echoes are the
    // common way a page reshapes a value (browser-use redaction bug #5083).
    pattern = alternatives.length === 0 ? null : new RegExp(alternatives.join("|"), "giu");
  };

  const redactText = (text: string) =>
    pattern === null ? text : text.replace(pattern, REDACTED_CREDENTIAL);

  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return redactText(value);
    // Past this depth a structure is not page data anyone reads; mask it whole
    // rather than hand it back unexamined.
    if (depth > 64) return REDACTED_CREDENTIAL;
    if (value === null || typeof value !== "object" || value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        typeof entry === "object" && entry !== null && isImagePayload(entry)
          ? Object.fromEntries(
              Object.entries(entry).map(([field, inner]) => [
                field,
                field === "data" ? inner : walk(inner, depth + 2),
              ]),
            )
          : walk(entry, depth + 1),
      ]),
    );
  };

  return {
    remember: (value) => {
      if (value.length < MIN_REDACTED_LENGTH || secrets.has(value)) return;
      secrets.add(value);
      rebuild();
    },
    redactText,
    redact: <A>(value: A): A => (pattern === null ? value : (walk(value, 0) as A)),
  };
}
