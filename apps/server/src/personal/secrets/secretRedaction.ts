/**
 * Masks every saved secret value wherever text leaves the server: provider
 * events (chat text, tool output, activity), task results, logs and what a bot
 * types into the shared browser.
 *
 * The structural rail is the broker (`secret_request`): a brokered key's value
 * never reaches a bot. This is the belt for keys still in `env` mode, which a
 * bot with a shell can print, and for a brokered value an API echoes back. It
 * is not a boundary on its own: a bot that transforms a value (reverses it,
 * splits it across lines, hashes it) gets past it, which is why Settings steers
 * keys to brokered mode.
 *
 * It learns values from the secret store (`PersonalSecretService` keeps it in
 * step) and masks the raw value and the spellings a value commonly turns into:
 * URL-encoded (either case of the escapes), form-encoded, JSON-escaped (also with
 * `\/` for slashes), hex (either case), and base64 / base64url both
 * alone and embedded in a longer string (`Authorization: Basic ...`).
 *
 * Kill switch: `PERSONAL_SECRET_REDACT=off` (also 0 / false / no, and the
 * `T3CODE_` prefixed spelling the other switches use), read on every call, so
 * an idle restart is enough to turn it off.
 */

/**
 * Shorter values would mask ordinary words (a 4-character key would blank every
 * "true" or "null"); the store allows them, redaction skips them. A key under
 * this length is therefore not masked anywhere, so use a real, long API key
 * and keep short secrets out of bots' reach.
 */
export const MIN_REDACTED_SECRET_LENGTH = 8;

/** The text a masked value becomes. */
export const redactedSecretText = (name: string) => `[secret ${name}]`;

const OFF_VALUES = new Set(["off", "0", "false", "no"]);

/** True unless the kill switch is set. */
export const secretRedactionEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const raw = env.PERSONAL_SECRET_REDACT ?? env.T3CODE_PERSONAL_SECRET_REDACT;
  return raw === undefined || !OFF_VALUES.has(raw.trim().toLowerCase());
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toBase64Url = (value: string) => value.replaceAll("+", "-").replaceAll("/", "_");

/**
 * The base64 spellings of `value`, alone and inside a longer string. Inside a
 * longer string the encoding depends on where the value starts modulo three,
 * so the three alignments are produced and the characters that mix in the
 * neighbouring bytes are cut off both ends.
 */
const base64Variants = (value: string): ReadonlyArray<string> => {
  const bytes = Buffer.from(value, "utf8");
  const out: Array<string> = [];
  for (const lead of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(lead), bytes]).toString("base64");
    const start = Math.ceil((lead * 4) / 3);
    const unpadded = encoded.replace(/=+$/, "");
    const tail = (lead + bytes.length) % 3 === 0 ? unpadded : unpadded.slice(0, -1);
    const stable = tail.slice(start);
    if (stable.length >= MIN_REDACTED_SECRET_LENGTH) {
      out.push(stable, toBase64Url(stable));
    }
  }
  const padded = bytes.toString("base64");
  out.push(padded, toBase64Url(padded), padded.replace(/=+$/, ""));
  return out;
};

/** Every spelling of `value` the redactor looks for. */
export const secretVariants = (value: string): ReadonlyArray<string> => {
  const variants = new Set<string>([value]);
  const urlEncoded = encodeURIComponent(value);
  variants.add(urlEncoded);
  variants.add(urlEncoded.replaceAll("%20", "+"));
  variants.add(encodeURI(value));
  // Some encoders write the percent escapes in lower case.
  variants.add(urlEncoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
  // JSON string escaping (a quote, a backslash or a newline inside the value),
  // and the `\/` form some serializers (PHP, Ruby) write for every slash.
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  variants.add(jsonEscaped);
  variants.add(jsonEscaped.replaceAll("/", "\\/"));
  const hex = Buffer.from(value, "utf8").toString("hex");
  variants.add(hex);
  variants.add(hex.toUpperCase());
  for (const variant of base64Variants(value)) variants.add(variant);
  return [...variants].filter((variant) => variant.length >= MIN_REDACTED_SECRET_LENGTH);
};

/** Text that is passed through a stream a piece at a time (see {@link SecretStream}). */
export interface SecretStream {
  /** The text of `delta` that is safe to emit now; a possible start of a secret is held back. */
  readonly push: (delta: string) => string;
  /** Whatever is still held, redacted. Call when the stream ends. */
  readonly flush: () => string;
  /** True while a tail is held back. */
  readonly holding: () => boolean;
}

export interface SecretRedactor {
  /**
   * Replaces everything the redactor knows with exactly these entries. `id`
   * tells apart two bots' values of one name; it defaults to the name.
   */
  readonly replaceAll: (
    entries: ReadonlyArray<{ readonly name: string; readonly value: string; readonly id?: string }>,
  ) => void;
  readonly set: (name: string, value: string, id?: string) => void;
  /** Forgets every value saved under `name`. */
  readonly remove: (name: string) => void;
  readonly clear: () => void;
  /** How many secrets are known (those long enough to mask). */
  readonly size: () => number;
  /** True when something would be masked: a key is known and the kill switch is not set. */
  readonly active: () => boolean;
  /** The names of the secrets that are long enough to mask. */
  readonly names: () => ReadonlyArray<string>;
  /** `text` with each known value replaced by `[secret NAME]`. */
  readonly redactText: (text: string) => string;
  /**
   * A copy of `value` with every string masked; the same reference when
   * nothing changed. An image payload (`{ mimeType: "image/..", data }`)
   * passes through.
   */
  readonly redact: <A>(value: A) => A;
  readonly stream: () => SecretStream;
}

interface Compiled {
  readonly pattern: RegExp;
  readonly nameOf: ReadonlyMap<string, string>;
  readonly variants: ReadonlyArray<string>;
  readonly firstChars: ReadonlySet<string>;
  readonly longest: number;
}

const EMPTY: Compiled = {
  pattern: /(?!)/g,
  nameOf: new Map(),
  variants: [],
  firstChars: new Set(),
  longest: 0,
};

const MAX_REDACT_DEPTH = 24;

const isImagePayload = (value: object): boolean => {
  const record = value as { readonly mimeType?: unknown; readonly data?: unknown };
  return (
    typeof record.mimeType === "string" &&
    record.mimeType.startsWith("image/") &&
    typeof record.data === "string"
  );
};

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

export function makeSecretRedactor(
  options: { readonly enabled?: () => boolean } = {},
): SecretRedactor {
  const enabled = options.enabled ?? secretRedactionEnabled;
  const secrets = new Map<string, { readonly name: string; readonly value: string }>();
  let compiled: Compiled = EMPTY;

  const rebuild = () => {
    const nameOf = new Map<string, string>();
    for (const { name, value } of secrets.values()) {
      if (value.length < MIN_REDACTED_SECRET_LENGTH) continue;
      for (const variant of secretVariants(value)) {
        if (!nameOf.has(variant)) nameOf.set(variant, name);
      }
    }
    if (nameOf.size === 0) {
      compiled = EMPTY;
      return;
    }
    // Longest first, so an encoded spelling is replaced whole rather than
    // leaving its tail behind after the raw value matched inside it.
    const variants = [...nameOf.keys()].toSorted((left, right) => right.length - left.length);
    compiled = {
      pattern: new RegExp(variants.map(escapeRegExp).join("|"), "gu"),
      nameOf,
      variants,
      firstChars: new Set(variants.map((variant) => variant[0]!)),
      longest: variants[0]!.length,
    };
  };

  const redactText = (text: string): string => {
    if (compiled === EMPTY || text.length < MIN_REDACTED_SECRET_LENGTH || !enabled()) return text;
    const { pattern, nameOf } = compiled;
    pattern.lastIndex = 0;
    return text.replace(pattern, (match) => redactedSecretText(nameOf.get(match) ?? "key"));
  };

  const redactValue = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return redactText(value);
    if (value === null || typeof value !== "object" || depth > MAX_REDACT_DEPTH) return value;
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((entry: unknown) => {
        const redacted = redactValue(entry, depth + 1);
        if (redacted !== entry) changed = true;
        return redacted;
      });
      return changed ? next : value;
    }
    if (!isPlainObject(value) || isImagePayload(value)) return value;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const redacted = redactValue(entry, depth + 1);
      if (redacted !== entry) changed = true;
      next[key] = redacted;
    }
    return changed ? next : value;
  };

  /** Where a held tail starts: the longest suffix that could still grow into a secret. */
  const heldStart = (text: string): number => {
    const { variants, firstChars, longest } = compiled;
    const from = Math.max(0, text.length - (longest - 1));
    for (let index = from; index < text.length; index++) {
      if (!firstChars.has(text[index]!)) continue;
      const suffix = text.slice(index);
      if (
        variants.some((variant) => variant.length > suffix.length && variant.startsWith(suffix))
      ) {
        return index;
      }
    }
    return text.length;
  };

  const stream = (): SecretStream => {
    let carry = "";
    return {
      push: (delta) => {
        if (compiled === EMPTY || !enabled()) {
          const out = carry + delta;
          carry = "";
          return out;
        }
        const redacted = redactText(carry + delta);
        const start = heldStart(redacted);
        carry = redacted.slice(start);
        return redacted.slice(0, start);
      },
      flush: () => {
        const out = redactText(carry);
        carry = "";
        return out;
      },
      holding: () => carry.length > 0,
    };
  };

  return {
    replaceAll: (entries) => {
      secrets.clear();
      for (const entry of entries) {
        secrets.set(entry.id ?? entry.name, { name: entry.name, value: entry.value });
      }
      rebuild();
    },
    set: (name, value, id = name) => {
      secrets.set(id, { name, value });
      rebuild();
    },
    remove: (name) => {
      let removed = false;
      for (const [id, entry] of secrets) {
        if (entry.name === name) removed = secrets.delete(id) || removed;
      }
      if (removed) rebuild();
    },
    clear: () => {
      secrets.clear();
      rebuild();
    },
    size: () =>
      [...secrets.values()].filter((entry) => entry.value.length >= MIN_REDACTED_SECRET_LENGTH)
        .length,
    active: () => compiled !== EMPTY && enabled(),
    names: () => [
      ...new Set(
        [...secrets.values()]
          .filter((entry) => entry.value.length >= MIN_REDACTED_SECRET_LENGTH)
          .map((entry) => entry.name),
      ),
    ],
    redactText,
    redact: <A>(value: A): A =>
      compiled === EMPTY || !enabled() ? value : (redactValue(value, 0) as A),
    stream,
  };
}

/**
 * The one redactor the server uses. A module singleton because the places that
 * need it (the logger, the provider event path, the browser) are built
 * separately from the secret service that feeds it.
 */
export const secretRedactor: SecretRedactor = makeSecretRedactor();
