import type {
  ConnectionId,
  PersonalConnectionSettings,
  PersonalConnectionVendorId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * The boundary between the gateway and a provider.
 *
 * An adapter is the only thing that talks to a vendor, and the only thing that
 * ever holds a credential value. It receives the already-validated arguments
 * and the credential fields as `Redacted`, so a value cannot reach a log or a
 * message by being interpolated somewhere careless upstream.
 *
 * A vendor with no adapter is refused rather than guessed at. The concrete
 * adapters live in `vendors/`; this file stays free of them so the boundary
 * can be imported by an adapter without an import cycle.
 */

export class ConnectionVendorError extends Schema.TaggedError<ConnectionVendorError>()(
  "ConnectionVendorError",
  {
    operationId: Schema.String,
    /** May quote the request back, so the gateway scrubs it before anyone reads it. */
    detail: Schema.String,
    /**
     * The vendor rejected the credential itself (401/403) rather than the
     * request. Absent means "we do not know", which is not the same as false:
     * only a status we read says a token has to be replaced.
     */
    unauthorized: Schema.optionalKey(Schema.Boolean),
    /**
     * Whose credential was refused when `unauthorized` is set. Absent means
     * the call's own (primary) connection; `secondary` is the account a
     * transfer writes into, which is the one that has to be reconnected.
     */
    rejectedCredential: Schema.optionalKey(Schema.Literals(["primary", "secondary"])),
    /**
     * The HTTP status the vendor answered with, when it answered at all. A
     * 4xx is a definite refusal (nothing was done); absent or 5xx means the
     * vendor may or may not have acted.
     */
    status: Schema.optionalKey(Schema.Number),
  },
) {}

/** Safe, owner-readable identity of the account a token turned out to belong to. */
export interface ConnectionVendorAccount {
  readonly accountId: string;
  readonly accountName: string;
  readonly teamId: string | null;
  readonly teamName: string | null;
}

/**
 * What one validation call learned about a token.
 *
 * `grantedScopes` is `null` when the vendor does not report scopes at all,
 * which is not the same as an empty list: one means "we cannot tell", the
 * other means "this token has none". The service refuses to call a required
 * scope satisfied on a `null`.
 */
export interface ConnectionVendorValidation {
  readonly account: ConnectionVendorAccount;
  readonly grantedScopes: ReadonlyArray<string> | null;
  /** Operation ids this account was shown to be able to run. */
  readonly verifiedCapabilities: ReadonlyArray<string>;
}

export interface ConnectionVendorCall {
  readonly operationId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly credentials: Readonly<Record<string, Redacted.Redacted<string>>>;
  /**
   * Which connection this call is for, and what the owner set on it.
   *
   * A token vendor has no use for either: its account is the token. They exist
   * for a vendor whose limits are the owner's own decision rather than a
   * provider's — WhatsApp's daily send cap is a number in Settings, and the
   * ledger that enforces it is keyed on the connection, not on the account
   * name the page happens to report.
   */
  readonly connectionId: ConnectionId;
  readonly settings: PersonalConnectionSettings;
  /**
   * The account this connection was validated against, as the owner saw it on
   * the connect screen. A vendor that scopes requests by team reads it from
   * here rather than re-resolving one per call: the approval was given for a
   * connection whose team was already named, and re-resolving could pick a
   * different one.
   */
  readonly account: ConnectionVendorAccount | null;
  /**
   * A second connection the operation declared it needs, resolved and read by
   * the gateway in the same call.
   *
   * It is how a credential one provider minted reaches the place it is used
   * without ever becoming an argument, a result, or transcript text. Absent
   * for every ordinary operation; an operation that needs one refuses when it
   * is missing rather than doing half of the work.
   */
  readonly secondary?: {
    readonly vendorId: PersonalConnectionVendorId;
    readonly credentials: Readonly<Record<string, Redacted.Redacted<string>>>;
    readonly account: ConnectionVendorAccount | null;
  };
}

export interface ConnectionVendorAdapter {
  readonly vendorId: PersonalConnectionVendorId;
  /**
   * The vendor request/response shape this adapter currently speaks. The
   * gateway compares it with the shape the operation was reviewed against and
   * stops when they differ: a provider that changed its contract under us is
   * not something to execute against unattended.
   */
  readonly vendorSchema: (operationId: string) => Effect.Effect<string, ConnectionVendorError>;
  readonly execute: (
    call: ConnectionVendorCall,
  ) => Effect.Effect<Readonly<Record<string, unknown>>, ConnectionVendorError>;
  /**
   * Calls the vendor with a candidate credential and reports who it belongs to
   * and what it may do. Runs at the connect screen so a wrong or short-scoped
   * token fails while the owner is still looking at it, rather than in the
   * middle of somebody's task an hour later.
   */
  readonly validate: (
    credentials: Readonly<Record<string, Redacted.Redacted<string>>>,
  ) => Effect.Effect<ConnectionVendorValidation, ConnectionVendorError>;
}

export class ConnectionVendorAdapters extends Context.Service<
  ConnectionVendorAdapters,
  {
    readonly forVendor: (
      vendorId: PersonalConnectionVendorId,
    ) => Option.Option<ConnectionVendorAdapter>;
  }
>()("t3/personal/connections/adapters/ConnectionVendorAdapters") {}

export const makeAdapters = (adapters: ReadonlyArray<ConnectionVendorAdapter>) =>
  ConnectionVendorAdapters.of({
    forVendor: (vendorId) =>
      Option.fromNullishOr(adapters.find((adapter) => adapter.vendorId === vendorId)),
  });

export const layerOf = (adapters: ReadonlyArray<ConnectionVendorAdapter>) =>
  Layer.succeed(ConnectionVendorAdapters, makeAdapters(adapters));

/** No vendors at all: what a test that is not about a vendor wants. */
export const layerEmpty = layerOf([]);
