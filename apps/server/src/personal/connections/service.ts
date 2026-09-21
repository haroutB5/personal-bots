import * as NodeCrypto from "node:crypto";

import {
  ConnectionId,
  EMPTY_PERSONAL_CONNECTION_SETTINGS,
  WHATSAPP_DEFAULT_DAILY_SEND_CAP,
  PERSONAL_SECRET_MAX_VALUE_BYTES,
  PersonalConnectionsError,
  type PersonalConnection,
  type PersonalConnectionConnectInput,
  type PersonalConnectionIdInput,
  type PersonalConnectionImportAdoptInput,
  type PersonalConnectionImportResult,
  type PersonalConnectionListResult,
  type PersonalConnectionBrowserConnectInput,
  type PersonalConnectionBrowserConnectResult,
  type PersonalConnectionRotateInput,
  type PersonalConnectionSettings,
  type PersonalConnectionSettingsInput,
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
import { connectionDefinition, usesBrowserSession } from "./catalog.ts";
import * as CredentialStore from "./credentialStore.ts";
import * as MachineImport from "./machineImport.ts";
import { scrubCredentialValues } from "./operations.ts";
import * as Repository from "./repository.ts";
import { WhatsAppSession } from "./whatsapp/session.ts";

export interface ResolvedPersonalConnection {
  readonly connectionId: ConnectionId;
  readonly vendorId: PersonalConnectionVendorId;
  readonly credentialRef: string;
  readonly credentialVersion: number;
  /** Safe identity only: what the adapter needs to scope a request, never a value. */
  readonly account: PersonalConnection["account"];
  /** What the owner set on this connection; re-read per call, like the rest. */
  readonly settings: PersonalConnectionSettings;
}

export class PersonalConnectionService extends Context.Service<
  PersonalConnectionService,
  {
    readonly list: () => Effect.Effect<PersonalConnectionListResult, PersonalConnectionsError>;
    readonly connect: (
      input: PersonalConnectionConnectInput,
    ) => Effect.Effect<PersonalConnection, PersonalConnectionsError>;
    /**
     * The browser-session way in: the server opens the vendor's site in the
     * shared browser and hands the owner control so they can sign in - for
     * WhatsApp, scan the QR with their phone. No credential moves in either
     * direction, because there is none. `viewerSessionId` is the owner's own
     * client session, so control lands on the device they are holding.
     */
    readonly browserConnect: (
      input: PersonalConnectionBrowserConnectInput,
      viewerSessionId: string,
    ) => Effect.Effect<PersonalConnectionBrowserConnectResult, PersonalConnectionsError>;
    /** Owner-only, never bot-reachable: the send cap is theirs to set. */
    readonly setSettings: (
      input: PersonalConnectionSettingsInput,
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
    /** Owner-triggered scan of this machine's own CLI logins. Never bot-reachable. */
    readonly importProbe: () => Effect.Effect<
      PersonalConnectionImportResult,
      PersonalConnectionsError
    >;
    /**
     * Adopts one candidate by re-reading its source here. Finding a value is
     * not proof it can provision anything, so this goes through the same
     * validating connect path a pasted token does.
     */
    readonly importAdopt: (
      input: PersonalConnectionImportAdoptInput,
    ) => Effect.Effect<PersonalConnection, PersonalConnectionsError>;
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

/** A new connection starts at the vendor's own safe default, written down. */
const defaultSettingsFor = (vendorId: PersonalConnectionVendorId): PersonalConnectionSettings =>
  vendorId === "whatsapp"
    ? {
        ...EMPTY_PERSONAL_CONNECTION_SETTINGS,
        whatsappDailySendCap: WHATSAPP_DEFAULT_DAILY_SEND_CAP,
      }
    : EMPTY_PERSONAL_CONNECTION_SETTINGS;

export const make = Effect.gen(function* () {
  const repository = yield* Repository.PersonalConnectionRepository;
  const credentials = yield* CredentialStore.PersonalConnectionCredentialStore;
  const adapters = yield* Adapters.ConnectionVendorAdapters;
  const machineImport = yield* MachineImport.PersonalConnectionMachineImport;
  const whatsappSession = yield* WhatsAppSession;
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
    // `null` is "this vendor will not tell us", not "this token has none". A
    // fine-grained GitHub PAT sends no scope header by design, and it is both
    // the token GitHub recommends and the one a beginner is steered to, so
    // refusing it would turn away the better credential. Capabilities gate no
    // operation here, so accepting one grants nothing: it proves identity, and
    // a write the token cannot do fails against the vendor, whose 403 names
    // the permission far more precisely than a guess from this side could.
    const missingScopes =
      granted === null ? [] : definition.requiredScopes.filter((scope) => !granted.includes(scope));
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
    /**
     * A browser-session vendor stores nothing, so nothing reaches the
     * credential store - not even an empty record. The reference below is a
     * marker that keeps the table's shape; there is no value behind it, and
     * reading it back deliberately finds nothing.
     */
    const storedCredential = usesBrowserSession(input.vendorId)
      ? { credentialRef: `browser-session-${NodeCrypto.randomUUID()}`, version: 1 }
      : yield* secret(credentials.create(values));
    const now = yield* DateTime.now;
    const checked = check._tag === "ok";
    const stored: Repository.StoredPersonalConnection = {
      connectionId: ConnectionId.make(NodeCrypto.randomUUID()),
      vendorId: input.vendorId,
      status: checked ? "connected" : "connecting",
      account: checked ? check.account : null,
      verifiedCapabilities: checked ? [...new Set(check.verifiedCapabilities)] : [],
      settings: defaultSettingsFor(input.vendorId),
      credentialRef: storedCredential.credentialRef,
      credentialVersion: storedCredential.version,
      lastValidatedAt: checked ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    yield* db("create", repository.create(stored)).pipe(
      Effect.tapError(() =>
        usesBrowserSession(input.vendorId)
          ? Effect.void
          : credentials.remove(storedCredential).pipe(Effect.ignore),
      ),
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
    // A browser session has nothing stored to read, and its "credential" is
    // whether the page is still signed in - which is exactly what the adapter
    // goes and looks at.
    const stored = usesBrowserSession(previous.vendorId)
      ? Option.some({} as PersonalConnectionConnectInput["credentials"])
      : yield* secret(
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
    // credential on disk. A browser session has no value to delete, and
    // removing the connection deliberately does not sign the owner out of the
    // site: that is theirs to do, and the screen says so.
    if (!usesBrowserSession(previous.vendorId)) {
      yield* secret(
        credentials.remove({
          credentialRef: previous.credentialRef,
          version: previous.credentialVersion,
        }),
      );
    }
    const removed = yield* db("delete", repository.remove(input.connectionId));
    if (!removed) return yield* fail("Connection changed while it was being disconnected.");
    return { disconnected: true as const };
  });

  const rotateUnlocked = Effect.fn("PersonalConnectionService.rotate")(function* (
    input: PersonalConnectionRotateInput,
  ) {
    const previous = yield* requireConnection(input.connectionId);
    if (usesBrowserSession(previous.vendorId)) {
      return yield* fail(
        `${connectionDefinition(previous.vendorId).displayName} has no token to replace. Sign in again from the Connections screen instead.`,
      );
    }
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

  const importAdoptUnlocked = Effect.fn("PersonalConnectionService.importAdopt")(function* (
    input: PersonalConnectionImportAdoptInput,
  ) {
    const found = yield* machineImport.probe();
    const candidate = found.candidates.find((entry) => entry.candidateId === input.candidateId);
    if (candidate === undefined) {
      return yield* fail(
        "That saved login is no longer on this machine. Scan again and pick from what it finds.",
      );
    }
    // Read here and passed straight on: the value is never part of a reply and
    // never crosses the wire in either direction.
    const credentials = yield* machineImport.readCredential(input.candidateId);
    return yield* connectUnlocked({ vendorId: candidate.vendorId, credentials });
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

  const browserConnectUnlocked = Effect.fn("PersonalConnectionService.browserConnect")(function* (
    input: PersonalConnectionBrowserConnectInput,
    viewerSessionId: string,
  ) {
    const definition = connectionDefinition(input.vendorId);
    if (!usesBrowserSession(input.vendorId)) {
      return yield* fail(
        `${definition.displayName} is connected by pasting a token, not by signing in.`,
      );
    }
    const existing = yield* db("lookup", repository.getByVendor(input.vendorId));
    const now = yield* DateTime.now;
    // Re-running this is the way back from an expired session, so an existing
    // connection moves to `connecting` rather than being refused: the owner is
    // about to scan a new code for the same account.
    const stored: Repository.StoredPersonalConnection = Option.isSome(existing)
      ? { ...existing.value, status: "connecting", updatedAt: now }
      : {
          connectionId: ConnectionId.make(NodeCrypto.randomUUID()),
          vendorId: input.vendorId,
          status: "connecting",
          account: null,
          verifiedCapabilities: [],
          settings: defaultSettingsFor(input.vendorId),
          credentialRef: `browser-session-${NodeCrypto.randomUUID()}`,
          credentialVersion: 1,
          lastValidatedAt: null,
          createdAt: now,
          updatedAt: now,
        };
    if (Option.isSome(existing)) yield* write(stored);
    else yield* db("create", repository.create(stored));

    yield* whatsappSession
      .openForSignIn(viewerSessionId)
      .pipe(
        Effect.mapError(() =>
          fail("The shared browser could not open WhatsApp Web. Try again from Connections."),
        ),
      );
    return {
      connection: Repository.presentConnection(stored),
      instruction:
        "WhatsApp Web is open in the shared browser and you have control. Scan the code with WhatsApp on your phone (Settings > Linked devices > Link a device), then come back here and tap Check now.",
    };
  });

  const setSettingsUnlocked = Effect.fn("PersonalConnectionService.setSettings")(function* (
    input: PersonalConnectionSettingsInput,
  ) {
    const previous = yield* requireConnection(input.connectionId);
    return Repository.presentConnection(
      yield* write({ ...previous, settings: input.settings, updatedAt: yield* DateTime.now }),
    );
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
                settings: connection.settings,
              })
            : Option.none(),
        ),
      ),
    );

  return PersonalConnectionService.of({
    list,
    connect: (input) => mutationLock.withPermit(connectUnlocked(input)),
    browserConnect: (input, viewerSessionId) =>
      mutationLock.withPermit(browserConnectUnlocked(input, viewerSessionId)),
    setSettings: (input) => mutationLock.withPermit(setSettingsUnlocked(input)),
    validate: (input) => mutationLock.withPermit(validateUnlocked(input)),
    disable: (input) => mutationLock.withPermit(disableUnlocked(input)),
    reconnect: (input) => mutationLock.withPermit(reconnectUnlocked(input)),
    disconnect: (input) => mutationLock.withPermit(disconnectUnlocked(input)),
    rotate: (input) => mutationLock.withPermit(rotateUnlocked(input)),
    importProbe: () => machineImport.probe(),
    importAdopt: (input) => mutationLock.withPermit(importAdoptUnlocked(input)),
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
  Layer.provideMerge(MachineImport.layer),
);
