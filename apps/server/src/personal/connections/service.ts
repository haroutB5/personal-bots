import * as NodeCrypto from "node:crypto";

import {
  ConnectionId,
  PERSONAL_SECRET_MAX_VALUE_BYTES,
  PersonalConnectionsError,
  type PersonalConnection,
  type PersonalConnectionConnectInput,
  type PersonalConnectionIdInput,
  type PersonalConnectionListResult,
  type PersonalConnectionRotateInput,
  type PersonalConnectionValidateInput,
  type PersonalConnectionValidationResult,
  type PersonalConnectionVendorId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";

import * as Adapters from "./adapters.ts";
import * as VendorAdapters from "./vendors/layer.ts";
import { connectionDefinition } from "./catalog.ts";
import * as CredentialStore from "./credentialStore.ts";
import { scrubCredentialValues } from "./operations.ts";
import * as Repository from "./repository.ts";

export interface ResolvedPersonalConnection {
  readonly connectionId: ConnectionId;
  readonly vendorId: PersonalConnectionVendorId;
  readonly credentialRef: string;
  readonly credentialVersion: number;
  /** Safe identity only: what the adapter needs to scope a request, never a value. */
  readonly account: PersonalConnection["account"];
}

export class PersonalConnectionService extends Context.Service<
  PersonalConnectionService,
  {
    readonly list: () => Effect.Effect<PersonalConnectionListResult, PersonalConnectionsError>;
    readonly connect: (
      input: PersonalConnectionConnectInput,
    ) => Effect.Effect<PersonalConnection, PersonalConnectionsError>;
    /** Calls the vendor. The client asks for this; it never reports the outcome. */
    readonly validate: (
      input: PersonalConnectionValidateInput,
    ) => Effect.Effect<PersonalConnectionValidationResult, PersonalConnectionsError>;
    /**
     * A vendor refused the credential mid-task. Called by the gateway, so a
     * token that expired on the provider's schedule shows up in Settings
     * instead of as a run of identical failures.
     */
    readonly markNeedsReauth: (
      connectionId: ConnectionId,
    ) => Effect.Effect<void, PersonalConnectionsError>;
    readonly disable: (
      input: PersonalConnectionIdInput,
    ) => Effect.Effect<PersonalConnection, PersonalConnectionsError>;
    readonly reconnect: (
      input: PersonalConnectionIdInput,
    ) => Effect.Effect<PersonalConnection, PersonalConnectionsError>;
    readonly disconnect: (
      input: PersonalConnectionIdInput,
    ) => Effect.Effect<{ readonly disconnected: boolean }, PersonalConnectionsError>;
    readonly rotate: (
      input: PersonalConnectionRotateInput,
    ) => Effect.Effect<PersonalConnection, PersonalConnectionsError>;
    /** Re-read for every operation so disable and rotation take effect immediately. */
    readonly resolveForOperation: (
      vendorId: PersonalConnectionVendorId,
    ) => Effect.Effect<Option.Option<ResolvedPersonalConnection>, PersonalConnectionsError>;
  }
>()("t3/personal/connections/service/PersonalConnectionService") {}

/** What one call to a vendor concluded about a candidate credential. */
type VendorCheck =
  | {
      readonly _tag: "ok";
      readonly account: PersonalConnection["account"];
      readonly verifiedCapabilities: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "needs_reauth";
      readonly problem: string;
      readonly missingScopes: ReadonlyArray<string>;
    }
  | { readonly _tag: "error"; readonly problem: string }
  /** No adapter for this vendor yet: nothing was learned, good or bad. */
  | { readonly _tag: "unchecked"; readonly problem: string };

export const make = Effect.gen(function* () {
  const repository = yield* Repository.PersonalConnectionRepository;
  const credentials = yield* CredentialStore.PersonalConnectionCredentialStore;
  const adapters = yield* Adapters.ConnectionVendorAdapters;
  const mutationLock = yield* Semaphore.make(1);

  // A future vendor adapter may fail with credential material nested in its
  // cause, so RPC-visible errors never retain underlying causes.
  const fail = (message: string) => new PersonalConnectionsError({ message });
  const db = <A>(
    operation: string,
    effect: Effect.Effect<A, Repository.PersonalConnectionRepositoryError>,
  ) => effect.pipe(Effect.mapError(() => fail(`Personal connections ${operation} failed.`)));
  const secret = <A>(
    effect: Effect.Effect<A, CredentialStore.PersonalConnectionCredentialStoreError>,
  ) => effect.pipe(Effect.mapError(() => fail("Connection credential storage failed.")));
  const requireConnection = Effect.fn("PersonalConnectionService.requireConnection")(function* (
    connectionId: ConnectionId,
  ) {
    const found = yield* db("lookup", repository.get(connectionId));
    if (Option.isNone(found)) return yield* fail("Connection was not found.");
    return found.value;
  });

  const validateCredentials = Effect.fn("PersonalConnectionService.validateCredentials")(function* (
    vendorId: PersonalConnectionVendorId,
    values: PersonalConnectionConnectInput["credentials"],
  ) {
    const expected = [...connectionDefinition(vendorId).requiredCredentialFields].sort();
    const supplied = Object.keys(values).sort();
    if (expected.length !== supplied.length || expected.some((name, i) => name !== supplied[i])) {
      return yield* fail(`Credentials for ${vendorId} must contain: ${expected.join(", ")}.`);
    }
    for (const value of Object.values(values)) {
      const bytes = new TextEncoder().encode(Redacted.value(value));
      if (bytes.byteLength === 0) return yield* fail("Credential values must not be empty.");
      if (bytes.byteLength > PERSONAL_SECRET_MAX_VALUE_BYTES) {
        return yield* fail(
          `Each credential value must be at most ${PERSONAL_SECRET_MAX_VALUE_BYTES} bytes.`,
        );
      }
    }
    return values;
  });

  /**
   * Asks the vendor who this token belongs to and what it may do.
   *
   * The vendor's own detail is scrubbed of every rendering of the credential
   * before it becomes an owner-facing sentence: a 401 body routinely quotes
   * the request, header included.
   */
  const checkWithVendor = Effect.fn("PersonalConnectionService.checkWithVendor")(function* (
    vendorId: PersonalConnectionVendorId,
    values: PersonalConnectionConnectInput["credentials"],
  ) {
    const definition = connectionDefinition(vendorId);
    const adapter = adapters.forVendor(vendorId);
    if (Option.isNone(adapter)) {
      return {
        _tag: "unchecked" as const,
        problem: `hbots cannot check a ${definition.displayName} token yet, so it is stored without being confirmed.`,
      };
    }
    const secrets = Object.values(values).map(Redacted.value);
    const outcome = yield* adapter.value.validate(values).pipe(
      Effect.map((validation) => ({ ok: true as const, validation })),
      Effect.catch((error) =>
        Effect.succeed({
          ok: false as const,
          unauthorized: error.unauthorized === true,
          detail: scrubCredentialValues(error.detail, secrets),
        }),
      ),
      // A defect carries a stack that quotes the call it came from.
      Effect.catchCause((cause) =>
        Effect.succeed({
          ok: false as const,
          unauthorized: false,
          detail: scrubCredentialValues(cause, secrets),
        }),
      ),
    );
    if (!outcome.ok) {
      const problem = `${definition.displayName} did not accept this token: ${outcome.detail}`;
      // A provider we could not reach says nothing about the token, so it is
      // an error rather than an instruction to go and mint a new one.
      return outcome.unauthorized
        ? { _tag: "needs_reauth" as const, problem, missingScopes: [] }
        : { _tag: "error" as const, problem };
    }
    const granted = outcome.validation.grantedScopes;
    // `null` is "the vendor does not report scopes", which cannot satisfy a
    // requirement; an empty list is a token that genuinely has none.
    const missingScopes =
      granted === null
        ? [...definition.requiredScopes]
        : definition.requiredScopes.filter((scope) => !granted.includes(scope));
    if (missingScopes.length > 0) {
      return {
        _tag: "needs_reauth" as const,
        missingScopes,
        problem: `This ${definition.displayName} token is missing ${missingScopes.join(", ")}. Create a token with ${definition.requiredScopes.join(" and ")} ticked.`,
      };
    }
    return {
      _tag: "ok" as const,
      account: outcome.validation.account,
      verifiedCapabilities: outcome.validation.verifiedCapabilities,
    };
  });

  const write = Effect.fn("PersonalConnectionService.write")(function* (
    next: Repository.StoredPersonalConnection,
  ) {
    const written = yield* db("update", repository.update(next));
    if (!written) return yield* fail("Connection changed while it was being updated.");
    return next;
  });

  const list: PersonalConnectionService["Service"]["list"] = () =>
    db("list", repository.list()).pipe(
      Effect.map((rows) => ({ connections: rows.map(Repository.presentConnection) })),
    );

  const connectUnlocked = Effect.fn("PersonalConnectionService.connect")(function* (
    input: PersonalConnectionConnectInput,
  ) {
    if (Option.isSome(yield* db("lookup", repository.getByVendor(input.vendorId)))) {
      return yield* fail("A connection for this vendor already exists.");
    }
    const values = yield* validateCredentials(input.vendorId, input.credentials);
    // Before anything is written: a token that cannot work is not a
    // connection, and the owner is still looking at the screen that made it.
    const check = yield* checkWithVendor(input.vendorId, values);
    if (check._tag === "needs_reauth" || check._tag === "error") {
      return yield* fail(check.problem);
    }
    const storedCredential = yield* secret(credentials.create(values));
    const now = yield* DateTime.now;
    const checked = check._tag === "ok";
    const stored: Repository.StoredPersonalConnection = {
      connectionId: ConnectionId.make(NodeCrypto.randomUUID()),
      vendorId: input.vendorId,
      status: checked ? "connected" : "connecting",
      account: checked ? check.account : null,
      verifiedCapabilities: checked ? [...new Set(check.verifiedCapabilities)] : [],
      credentialRef: storedCredential.credentialRef,
      credentialVersion: storedCredential.version,
      lastValidatedAt: checked ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    yield* db("create", repository.create(stored)).pipe(
      Effect.tapError(() => credentials.remove(storedCredential).pipe(Effect.ignore)),
    );
    return Repository.presentConnection(stored);
  });

  const validateUnlocked = Effect.fn("PersonalConnectionService.validate")(function* (
    input: PersonalConnectionValidateInput,
  ) {
    const previous = yield* requireConnection(input.connectionId);
    if (
      previous.status !== "connecting" &&
      previous.status !== "connected" &&
      // Re-checking a needs_reauth token is how the owner finds out they
      // extended it at the provider, so it stays a legal thing to ask.
      previous.status !== "needs_reauth"
    ) {
      return yield* fail(`A ${previous.status} connection must be reconnected before validation.`);
    }
    const stored = yield* secret(
      credentials.read({
        credentialRef: previous.credentialRef,
        version: previous.credentialVersion,
      }),
    );
    if (Option.isNone(stored)) {
      const missing = yield* write({
        ...previous,
        status: "needs_reauth",
        updatedAt: yield* DateTime.now,
      });
      return {
        connection: Repository.presentConnection(missing),
        missingScopes: [],
        problem: "The stored credential is gone. Paste the token again to reconnect.",
      };
    }
    const check = yield* checkWithVendor(previous.vendorId, stored.value);
    if (check._tag === "unchecked") {
      return {
        connection: Repository.presentConnection(previous),
        missingScopes: [],
        problem: check.problem,
      };
    }
    const now = yield* DateTime.now;
    const connected = check._tag === "ok";
    const next = yield* write({
      ...previous,
      status: connected ? "connected" : check._tag,
      account: connected ? check.account : previous.account,
      verifiedCapabilities: connected
        ? [...new Set(check.verifiedCapabilities)]
        : previous.verifiedCapabilities,
      lastValidatedAt: connected ? now : previous.lastValidatedAt,
      updatedAt: now,
    });
    return {
      connection: Repository.presentConnection(next),
      missingScopes: check._tag === "needs_reauth" ? check.missingScopes : [],
      problem: connected ? null : check.problem,
    };
  });

  const disableUnlocked = Effect.fn("PersonalConnectionService.disable")(function* (
    input: PersonalConnectionIdInput,
  ) {
    const previous = yield* requireConnection(input.connectionId);
    if (previous.status === "disabled") return Repository.presentConnection(previous);
    return Repository.presentConnection(
      yield* write({ ...previous, status: "disabled", updatedAt: yield* DateTime.now }),
    );
  });

  const reconnectUnlocked = Effect.fn("PersonalConnectionService.reconnect")(function* (
    input: PersonalConnectionIdInput,
  ) {
    const previous = yield* requireConnection(input.connectionId);
    if (
      previous.status !== "disabled" &&
      previous.status !== "needs_reauth" &&
      previous.status !== "error"
    ) {
      return yield* fail(`Connection cannot reconnect while ${previous.status}.`);
    }
    return Repository.presentConnection(
      yield* write({ ...previous, status: "connecting", updatedAt: yield* DateTime.now }),
    );
  });

  const disconnectUnlocked = Effect.fn("PersonalConnectionService.disconnect")(function* (
    input: PersonalConnectionIdInput,
  ) {
    const previous = yield* requireConnection(input.connectionId);
    // Delete the value first so a partial failure never leaves an unreferenced
    // credential on disk.
    yield* secret(
      credentials.remove({
        credentialRef: previous.credentialRef,
        version: previous.credentialVersion,
      }),
    );
    const removed = yield* db("delete", repository.remove(input.connectionId));
    if (!removed) return yield* fail("Connection changed while it was being disconnected.");
    return { disconnected: true as const };
  });

  const rotateUnlocked = Effect.fn("PersonalConnectionService.rotate")(function* (
    input: PersonalConnectionRotateInput,
  ) {
    const previous = yield* requireConnection(input.connectionId);
    const values = yield* validateCredentials(previous.vendorId, input.credentials);
    const previousHandle = {
      credentialRef: previous.credentialRef,
      version: previous.credentialVersion,
    };
    // The replacement is proven before the working one is retired: a failed
    // paste must not cost the owner the connection they already had.
    const check = yield* checkWithVendor(previous.vendorId, values);
    if (check._tag === "needs_reauth" || check._tag === "error") {
      return yield* fail(check.problem);
    }
    const nextHandle = yield* secret(credentials.createNext(previousHandle, values));
    const checked = check._tag === "ok";
    const now = yield* DateTime.now;
    const next: Repository.StoredPersonalConnection = {
      ...previous,
      status: previous.status === "disabled" ? "disabled" : checked ? "connected" : "connecting",
      account: checked ? check.account : previous.account,
      verifiedCapabilities: checked
        ? [...new Set(check.verifiedCapabilities)]
        : previous.verifiedCapabilities,
      lastValidatedAt: checked ? now : previous.lastValidatedAt,
      credentialRef: nextHandle.credentialRef,
      credentialVersion: nextHandle.version,
      updatedAt: now,
    };
    yield* write(next).pipe(
      Effect.tapError(() => credentials.remove(nextHandle).pipe(Effect.ignore)),
    );
    yield* credentials
      .remove(previousHandle)
      .pipe(
        Effect.catch(() => Effect.logWarning("Could not remove a retired connection credential.")),
      );
    return Repository.presentConnection(next);
  });

  const markNeedsReauthUnlocked = Effect.fn("PersonalConnectionService.markNeedsReauth")(function* (
    connectionId: ConnectionId,
  ) {
    const previous = yield* requireConnection(connectionId);
    // Only a live connection moves. Disabled is the owner own decision and
    // outranks a vendor 401; anything else is already in a worse state.
    if (previous.status !== "connected" && previous.status !== "connecting") return;
    yield* write({ ...previous, status: "needs_reauth", updatedAt: yield* DateTime.now });
  });

  const resolveForOperation: PersonalConnectionService["Service"]["resolveForOperation"] = (
    vendorId,
  ) =>
    db("resolve", repository.getByVendor(vendorId)).pipe(
      Effect.map(
        Option.flatMap((connection) =>
          connection.status === "connected"
            ? Option.some({
                connectionId: connection.connectionId,
                vendorId: connection.vendorId,
                credentialRef: connection.credentialRef,
                credentialVersion: connection.credentialVersion,
                account: connection.account,
              })
            : Option.none(),
        ),
      ),
    );

  return PersonalConnectionService.of({
    list,
    connect: (input) => mutationLock.withPermit(connectUnlocked(input)),
    validate: (input) => mutationLock.withPermit(validateUnlocked(input)),
    disable: (input) => mutationLock.withPermit(disableUnlocked(input)),
    reconnect: (input) => mutationLock.withPermit(reconnectUnlocked(input)),
    disconnect: (input) => mutationLock.withPermit(disconnectUnlocked(input)),
    rotate: (input) => mutationLock.withPermit(rotateUnlocked(input)),
    markNeedsReauth: (connectionId) =>
      mutationLock.withPermit(markNeedsReauthUnlocked(connectionId)),
    resolveForOperation,
  });
});

export const layer = Layer.effect(PersonalConnectionService, make);
export const layerLive = layer.pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(CredentialStore.layer),
  Layer.provideMerge(VendorAdapters.layer),
);
