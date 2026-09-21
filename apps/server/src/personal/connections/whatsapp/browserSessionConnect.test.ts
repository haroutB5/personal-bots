import { PersonalConnectionsError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as Adapters from "../adapters.ts";
import * as CredentialStore from "../credentialStore.ts";
import * as MachineImport from "../machineImport.ts";
import * as Repository from "../repository.ts";
import * as Service from "../service.ts";
import { WhatsAppSession, WhatsAppSessionError } from "./session.ts";

/**
 * The half of the WhatsApp connection that is not the adapter: connecting
 * without a credential, and what that has to leave behind. The claim under
 * test is the one the design makes loudest - that this feature stores nothing,
 * because the session is the credential and it never leaves the machine.
 */

const noMachineImport = Layer.succeed(
  MachineImport.PersonalConnectionMachineImport,
  MachineImport.PersonalConnectionMachineImport.of({
    probe: () => Effect.succeed({ candidates: [], sources: [] }),
    readCredential: () =>
      Effect.fail(new PersonalConnectionsError({ message: "no machine credentials in this test" })),
  }),
);

const makeHarness = (options?: { readonly signedOut?: boolean }) => {
  const rows = new Map<string, Repository.StoredPersonalConnection>();
  const secrets = new Map<string, Readonly<Record<string, Redacted.Redacted<string>>>>();
  const takenControlBy: Array<string> = [];
  let sequence = 0;

  const repository = Repository.PersonalConnectionRepository.of({
    list: () => Effect.succeed([...rows.values()]),
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(rows.get(connectionId))),
    getByVendor: (vendorId) =>
      Effect.succeed(
        Option.fromNullishOr([...rows.values()].find((row) => row.vendorId === vendorId)),
      ),
    create: (row) =>
      Effect.sync(() => {
        rows.set(row.connectionId, row);
      }),
    update: (row) =>
      Effect.sync(() => {
        if (!rows.has(row.connectionId)) return false;
        rows.set(row.connectionId, row);
        return true;
      }),
    remove: (connectionId) => Effect.sync(() => rows.delete(connectionId)),
  });

  const credentialStore = CredentialStore.PersonalConnectionCredentialStore.of({
    create: (credentials) =>
      Effect.sync(() => {
        const handle = { credentialRef: `opaque-${++sequence}`, version: 1 };
        secrets.set(CredentialStore.personalConnectionCredentialKey(handle), credentials);
        return handle;
      }),
    createNext: (previous, credentials) =>
      Effect.sync(() => {
        const handle = { credentialRef: `opaque-${++sequence}`, version: previous.version + 1 };
        secrets.set(CredentialStore.personalConnectionCredentialKey(handle), credentials);
        return handle;
      }),
    read: (handle) =>
      Effect.succeed(
        Option.fromNullishOr(secrets.get(CredentialStore.personalConnectionCredentialKey(handle))),
      ),
    remove: (handle) =>
      Effect.sync(() => {
        secrets.delete(CredentialStore.personalConnectionCredentialKey(handle));
      }),
  });

  const whatsapp: Adapters.ConnectionVendorAdapter = {
    vendorId: "whatsapp",
    vendorSchema: () => Effect.succeed("whatsapp/web-chat-list@2026-09-21"),
    execute: () => Effect.succeed({}),
    validate: () =>
      options?.signedOut === true
        ? Effect.fail(
            new Adapters.ConnectionVendorError({
              operationId: "whatsapp.validate",
              detail: "WhatsApp Web is showing the sign-in QR code.",
              unauthorized: true,
            }),
          )
        : Effect.succeed({
            account: {
              accountId: "+447700900000",
              accountName: "Harout",
              teamId: null,
              teamName: null,
            },
            grantedScopes: null,
            verifiedCapabilities: ["whatsapp.send_message"],
          }),
  };

  const session = Layer.succeed(
    WhatsAppSession,
    WhatsAppSession.of({
      openForSignIn: (viewerSessionId) =>
        Effect.sync(() => {
          takenControlBy.push(viewerSessionId);
        }),
      handBack: () => Effect.void,
      ensureOpen: () => Effect.void,
      read: () => Effect.fail(new WhatsAppSessionError({ detail: "not used here" })),
      openChat: () => Effect.void,
      typeMessage: () => Effect.void,
      submit: () => Effect.void,
    }),
  );

  return {
    rows,
    secrets,
    takenControlBy,
    layer: Service.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Repository.PersonalConnectionRepository, repository),
          Layer.succeed(CredentialStore.PersonalConnectionCredentialStore, credentialStore),
          Adapters.layerOf([whatsapp]),
          noMachineImport,
          session,
        ),
      ),
    ),
  };
};

describe("connecting WhatsApp through the browser", () => {
  it.effect("stores nothing at all, and hands control to the device that asked", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const connections = yield* Service.PersonalConnectionService;
      const started = yield* connections.browserConnect(
        { vendorId: "whatsapp" },
        "auth-session-phone",
      );

      expect(started.connection.status).toBe("connecting");
      expect(started.instruction).toContain("Scan");
      expect(harness.takenControlBy).toEqual(["auth-session-phone"]);
      // The claim the whole design rests on: there is no credential, so the
      // encrypted store is untouched. Not an empty record - nothing.
      expect([...harness.secrets.keys()]).toEqual([]);

      // And the reference kept on the row is a marker with nothing behind it,
      // so a future reader cannot mistake it for a handle on a secret.
      const row = [...harness.rows.values()][0]!;
      expect(row.credentialRef.startsWith("browser-session-")).toBe(true);
      expect(row.settings.whatsappDailySendCap).toBeGreaterThan(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("becomes connected by reading the owner's own account off the page", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const connections = yield* Service.PersonalConnectionService;
      const started = yield* connections.browserConnect({ vendorId: "whatsapp" }, "auth-session");
      const checked = yield* connections.validate({
        connectionId: started.connection.connectionId,
      });

      expect(checked.problem).toBeNull();
      expect(checked.connection.status).toBe("connected");
      expect(checked.connection.account?.accountId).toBe("+447700900000");
      expect([...harness.secrets.keys()]).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("moves an expired session to needs_reauth, which is the way back to the QR", () => {
    const harness = makeHarness({ signedOut: true });
    return Effect.gen(function* () {
      const connections = yield* Service.PersonalConnectionService;
      const started = yield* connections.browserConnect({ vendorId: "whatsapp" }, "auth-session");
      const checked = yield* connections.validate({
        connectionId: started.connection.connectionId,
      });
      expect(checked.connection.status).toBe("needs_reauth");

      // Scanning again reuses the same connection rather than refusing it as a
      // duplicate: WhatsApp expiring a linked device is routine, not an error.
      const again = yield* connections.browserConnect({ vendorId: "whatsapp" }, "auth-session");
      expect(again.connection.connectionId).toBe(started.connection.connectionId);
      expect(again.connection.status).toBe("connecting");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("refuses to rotate a token that does not exist", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const connections = yield* Service.PersonalConnectionService;
      const started = yield* connections.browserConnect({ vendorId: "whatsapp" }, "auth-session");
      const refused = yield* Effect.flip(
        connections.rotate({
          connectionId: started.connection.connectionId,
          credentials: { accessToken: Redacted.make("not-a-thing") },
        }),
      );
      expect(refused.message).toContain("no token to replace");
      expect([...harness.secrets.keys()]).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves the browser alone when it removes the connection", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const connections = yield* Service.PersonalConnectionService;
      const started = yield* connections.browserConnect({ vendorId: "whatsapp" }, "auth-session");
      const removed = yield* connections.disconnect({
        connectionId: started.connection.connectionId,
      });
      expect(removed.disconnected).toBe(true);
      expect([...harness.rows.keys()]).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("will not open the browser for a vendor that is connected by pasting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const connections = yield* Service.PersonalConnectionService;
      const refused = yield* Effect.flip(
        connections.browserConnect({ vendorId: "github" }, "auth-session"),
      );
      expect(refused.message).toContain("pasting a token");
      expect(harness.takenControlBy).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the send cap the owner set, within the bounds of the contract", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const connections = yield* Service.PersonalConnectionService;
      const started = yield* connections.browserConnect({ vendorId: "whatsapp" }, "auth-session");
      const updated = yield* connections.setSettings({
        connectionId: started.connection.connectionId,
        settings: { whatsappDailySendCap: 3 },
      });
      expect(updated.settings.whatsappDailySendCap).toBe(3);

      // Read back through the path the gateway actually uses, because that is
      // where the cap reaches the adapter from.
      yield* connections.validate({ connectionId: started.connection.connectionId });
      const resolved = yield* connections.resolveForOperation("whatsapp");
      expect(Option.isSome(resolved) && resolved.value.settings.whatsappDailySendCap).toBe(3);
    }).pipe(Effect.provide(harness.layer));
  });
});
