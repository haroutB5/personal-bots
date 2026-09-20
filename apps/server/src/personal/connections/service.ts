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
  type PersonalConnectionVendorId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";

import { connectionDefinition } from "./catalog.ts";
import * as CredentialStore from "./credentialStore.ts";
import * as Repository from "./repository.ts";

export interface ResolvedPersonalConnection {
  readonly connectionId: ConnectionId;
  readonly vendorId: PersonalConnectionVendorId;
  readonly credentialRef: string;
  readonly credentialVersion: number;
}

export class PersonalConnectionService extends Context.Service<
  PersonalConnectionService,
  {
    readonly list: () => Effect.Effect<PersonalConnectionListResult, PersonalConnectionsError>;
    readonly connect: (
      input: PersonalConnectionConnectInput,
    ) => Effect.Effect<PersonalConnection, PersonalConnectionsError>;
    readonly validate: (
      input: PersonalConnectionValidateInput,
    ) => Effect.Effect<PersonalConnection, PersonalConnectionsError>;
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

export const make = Effect.gen(function* () {
  const repository = yield* Repository.PersonalConnectionRepository;
  const credentials = yield* CredentialStore.PersonalConnectionCredentialStore;
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
    const storedCredential = yield* secret(credentials.create(values));
    const now = yield* DateTime.now;
    const stored: Repository.StoredPersonalConnection = {
      connectionId: ConnectionId.make(NodeCrypto.randomUUID()),
      vendorId: input.vendorId,
      status: "connecting",
      account: null,
      verifiedCapabilities: [],
      credentialRef: storedCredential.credentialRef,
      credentialVersion: storedCredential.version,
      lastValidatedAt: null,
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
    if (previous.status !== "connecting" && previous.status !== "connected") {
      return yield* fail(`A ${previous.status} connection must be reconnected before validation.`);
    }
    const connected = input.outcome.status === "connected";
    const now = yield* DateTime.now;
    const next = yield* write({
      ...previous,
      status: input.outcome.status,
      account: connected ? input.outcome.account : previous.account,
      verifiedCapabilities: connected
        ? [...new Set(input.outcome.verifiedCapabilities)]
        : previous.verifiedCapabilities,
      lastValidatedAt: connected ? now : previous.lastValidatedAt,
      updatedAt: now,
    });
    return Repository.presentConnection(next);
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
    const nextHandle = yield* secret(credentials.createNext(previousHandle, values));
    const next: Repository.StoredPersonalConnection = {
      ...previous,
      status: previous.status === "disabled" ? "disabled" : "connecting",
      credentialRef: nextHandle.credentialRef,
      credentialVersion: nextHandle.version,
      updatedAt: yield* DateTime.now,
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
    resolveForOperation,
  });
});

export const layer = Layer.effect(PersonalConnectionService, make);
export const layerLive = layer.pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(CredentialStore.layer),
);
