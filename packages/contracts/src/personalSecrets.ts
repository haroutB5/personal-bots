import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";
import { PersonalTaskId } from "./personalTasks.ts";

/**
 * A secret's name: UPPER_SNAKE, starting with a letter. It becomes the
 * environment variable `PB_SECRET_<NAME>` in the bot's provider sessions and
 * the server secret store key `personal-secret-<NAME>`, so the pattern is
 * also what keeps both of those safe.
 */
export const PersonalSecretName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,63}$/));
export type PersonalSecretName = typeof PersonalSecretName.Type;

/** Longest accepted secret value, in UTF-8 bytes. */
export const PERSONAL_SECRET_MAX_VALUE_BYTES = 4096;

/** Environment variable a fulfilled secret is exposed as. */
export const personalSecretEnvVar = (name: string) => `PB_SECRET_${name}`;

/**
 * How a saved key reaches a bot. `brokered` keys never leave the server: the
 * bot names them as `{{secret:NAME}}` in a `secret_request` call and the
 * server injects the value for the key's bound HTTPS origins only. `env` keys
 * are the `PB_SECRET_<NAME>` variable in the bot's shell (the way every key
 * worked before 1.66.0), which a bot with a shell can print.
 */
export const PersonalSecretMode = Schema.Literals(["brokered", "env"]);
export type PersonalSecretMode = typeof PersonalSecretMode.Type;

/** Most origins one brokered key can be bound to. */
export const PERSONAL_SECRET_MAX_ORIGINS = 8;

/** Hosts that only mean something inside a home or office network. */
const INTERNAL_HOST_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".intranet",
  ".localdomain",
  ".home.arpa",
];

/**
 * The canonical form of an origin a brokered key may be sent to:
 * `https://host[:port]`, lower case, no path, no login, no default port.
 * Returns null for anything that is not a public HTTPS site: another scheme,
 * a login in the address, an IP address, `localhost` or a single-label or
 * internal-looking host. A bare host such as `api.vercel.com` and a full
 * address with a path are both accepted; the path is dropped.
 */
export const normalizePersonalSecretOrigin = (raw: string): string | null => {
  const text = raw.trim();
  if (text.length === 0 || text.length > 300 || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  if (host.length === 0 || host.startsWith("[") || /^[0-9.]+$/.test(host)) return null;
  if (!host.includes(".") || host.endsWith(".")) return null;
  if (INTERNAL_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
    return null;
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  return url.origin;
};

/** Normalises a list of origins; null when any of them is not acceptable. */
export const normalizePersonalSecretOrigins = (
  raw: ReadonlyArray<string>,
): ReadonlyArray<string> | null => {
  const origins: Array<string> = [];
  for (const entry of raw) {
    const origin = normalizePersonalSecretOrigin(entry);
    if (origin === null) return null;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins.length <= PERSONAL_SECRET_MAX_ORIGINS ? origins : null;
};

/** The placeholder a bot writes where a brokered key's value belongs. */
export const personalSecretPlaceholder = (name: string) => `{{secret:${name}}}`;

export const PersonalSecretRequestId = TrimmedNonEmptyString.pipe(
  Schema.brand("PersonalSecretRequestId"),
);
export type PersonalSecretRequestId = typeof PersonalSecretRequestId.Type;

export const PersonalSecretRequestStatus = Schema.Literals(["pending", "fulfilled", "cancelled"]);
export type PersonalSecretRequestStatus = typeof PersonalSecretRequestStatus.Type;

/** A bot's request for a secret. Never carries the value. */
export const PersonalSecretRequest = Schema.Struct({
  requestId: PersonalSecretRequestId,
  /** The task that asked, and the root of its tree; null only for legacy rows. */
  taskId: Schema.NullOr(PersonalTaskId),
  rootTaskId: Schema.NullOr(PersonalTaskId),
  threadId: ThreadId,
  botId: PersonalBotId,
  name: PersonalSecretName,
  label: Schema.String,
  purpose: Schema.String,
  status: PersonalSecretRequestStatus,
  /** Shared secrets reach every bot's sessions, not only the requester's. */
  shared: Schema.Boolean,
  /**
   * How the saved key reaches a bot. Absent on rows written before 1.66.0
   * (which are all `env`). For a pending request it is the owner's choice
   * once they answer; the request itself only carries `origins` (below).
   */
  mode: Schema.optional(PersonalSecretMode),
  /**
   * The HTTPS origins a brokered key is bound to. On a pending request: the
   * origin the bot says the key is for, shown to the owner to confirm.
   */
  origins: Schema.optional(Schema.Array(Schema.String)),
  createdAt: Schema.DateTimeUtcFromString,
  fulfilledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type PersonalSecretRequest = typeof PersonalSecretRequest.Type;

/** A stored secret as the client may see it: name, label and dates only. */
/**
 * A key the owner saved themselves, rather than one a bot asked for.
 *
 * The name is the whole point and the only part that can be got wrong: a bot
 * reads the value as `PB_SECRET_<NAME>`, so a key saved under a name nothing
 * looks for is invisible rather than broken. It is validated to the same
 * UPPER_SNAKE shape a bot's own request must use.
 */
export const PersonalSecretCreateInput = Schema.Struct({
  name: PersonalSecretName,
  /** What the owner calls it in the list. Defaults to the name. */
  label: Schema.optional(Schema.String),
  value: Schema.Redacted(Schema.String),
  /** Owner-added keys are shared by default; every bot can use every saved key. */
  shared: Schema.optional(Schema.Boolean),
  /** Defaults to `brokered`, which needs `origins`. */
  mode: Schema.optional(PersonalSecretMode),
  /** The HTTPS origins a brokered key may be sent to, e.g. `https://api.vercel.com`. */
  origins: Schema.optional(Schema.Array(Schema.String)),
});
export type PersonalSecretCreateInput = typeof PersonalSecretCreateInput.Type;

export const PersonalSecretSummary = Schema.Struct({
  name: PersonalSecretName,
  label: Schema.String,
  botIds: Schema.Array(PersonalBotId),
  shared: Schema.Boolean,
  /** `env` for keys saved before 1.66.0 until the owner moves them. */
  mode: PersonalSecretMode,
  /** Canonical origins a brokered key is bound to; empty for `env` keys. */
  origins: Schema.Array(Schema.String),
  fulfilledAt: Schema.DateTimeUtcFromString,
});
export type PersonalSecretSummary = typeof PersonalSecretSummary.Type;

export const PersonalSecretsListPendingResult = Schema.Struct({
  requests: Schema.Array(PersonalSecretRequest),
});
export type PersonalSecretsListPendingResult = typeof PersonalSecretsListPendingResult.Type;

export const PersonalSecretsListResult = Schema.Struct({
  secrets: Schema.Array(PersonalSecretSummary),
});
export type PersonalSecretsListResult = typeof PersonalSecretsListResult.Type;

export const PersonalSecretFulfillInput = Schema.Struct({
  requestId: PersonalSecretRequestId,
  /**
   * Redacted on the server so it never prints. On the wire it is the plain
   * string; clients wrap it with `Redacted.make`. The server enforces
   * `PERSONAL_SECRET_MAX_VALUE_BYTES` without echoing the value back.
   */
  value: Schema.Redacted(Schema.String),
  shared: Schema.optional(Schema.Boolean),
  /**
   * Defaults to `brokered`. A brokered key needs at least one origin, from
   * `origins` or the one the bot asked for on the request.
   */
  mode: Schema.optional(PersonalSecretMode),
  origins: Schema.optional(Schema.Array(Schema.String)),
});
export type PersonalSecretFulfillInput = typeof PersonalSecretFulfillInput.Type;

export const PersonalSecretRequestIdInput = Schema.Struct({
  requestId: PersonalSecretRequestId,
});
export type PersonalSecretRequestIdInput = typeof PersonalSecretRequestIdInput.Type;

export const PersonalSecretNameInput = Schema.Struct({
  name: PersonalSecretName,
});
export type PersonalSecretNameInput = typeof PersonalSecretNameInput.Type;

export const PersonalSecretSharingInput = Schema.Struct({
  name: PersonalSecretName,
  shared: Schema.Boolean,
});
export type PersonalSecretSharingInput = typeof PersonalSecretSharingInput.Type;

/** Moves a saved key between `env` and `brokered`, and sets the origins it is bound to. */
export const PersonalSecretModeInput = Schema.Struct({
  name: PersonalSecretName,
  mode: PersonalSecretMode,
  origins: Schema.optional(Schema.Array(Schema.String)),
});
export type PersonalSecretModeInput = typeof PersonalSecretModeInput.Type;

export class PersonalSecretsError extends Schema.TaggedError<PersonalSecretsError>()(
  "PersonalSecretsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
