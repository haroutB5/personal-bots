import { PersonalConnectionsError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as Adapters from "./adapters.ts";
import * as MachineImport from "./machineImport.ts";
import * as CredentialStore from "./credentialStore.ts";
import * as Repository from "./repository.ts";
import * as Service from "./service.ts";
import { WhatsAppSession } from "./whatsapp/session.ts";

/** These cover token vendors; WhatsApp's shared browser is never opened here. */
const noWhatsAppSession = Layer.mock(WhatsAppSession)({});

/**
 * Connecting a vendor is a call to that vendor, not a write. These cover what
 * that call is allowed to conclude: which token is refused, which scope is
 * named, and which failure is the owner's to fix.
 */

const TOKEN = "fake-token-must-never-escape";

const ACCOUNT = {
  accountId: "account-1",
  accountName: "Octocat",
  teamId: null,
  teamName: null,
};

/** Importing is not what these cover; the probe finds nothing. */
const noMachineImport = Layer.succeed(
  MachineImport.PersonalConnectionMachineImport,
  MachineImport.PersonalConnectionMachineImport.of({
    probe: () => Effect.succeed({ candidates: [], sources: [] }),
    readCredential: () =>
      Effect.fail(new PersonalConnectionsError({ message: "no machine credentials in this test" })),
  }),
);

const makeHarness = () => {
  const rows = new Map<string, Repository.StoredPersonalConnection>();
  const secrets = new Map<string, Readonly<Record<string, Redacted.Redacted<string>>>>();
  let sequence = 0;
  const vendor = {
    grantedScopes: ["repo", "workflow"] as ReadonlyArray<string> | null,
    reject: "none" as "none" | "unauthorized" | "offline",
  };

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

  const github: Adapters.ConnectionVendorAdapter = {
    vendorId: "github",
    vendorSchema: () => Effect.succeed("github/repos@2026-09-20"),
    execute: () => Effect.succeed({}),
    validate: (credentials) =>
      vendor.reject === "unauthorized"
        ? Effect.fail(
            new Adapters.ConnectionVendorError({
              operationId: "github.validate",
              // Vendors quote the request back at us, token included.
              detail: `HTTP 401 for token ${Redacted.value(credentials["accessToken"] ?? Redacted.make(""))}`,
              unauthorized: true,
            }),
          )
        : vendor.reject === "offline"
          ? Effect.fail(
              new Adapters.ConnectionVendorError({
                operationId: "github.validate",
                detail: "Could not reach the provider",
              }),
            )
          : Effect.succeed({
              account: ACCOUNT,
              grantedScopes: vendor.grantedScopes,
              verifiedCapabilities: ["github.create_repository", "github.create_repository"],
            }),
  };

  return {
    rows,
    secrets,
    vendor,
    layer: Service.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Repository.PersonalConnectionRepository, repository),
          Layer.succeed(CredentialStore.PersonalConnectionCredentialStore, credentialStore),
          Adapters.layerOf([github]),
          noMachineImport,
          noWhatsAppSession,
        ),
      ),
    ),
  };
};

const connectGithub = Effect.gen(function* () {
  const service = yield* Service.PersonalConnectionService;
  return yield* service.connect({
    vendorId: "github",
    credentials: { accessToken: Redacted.make(TOKEN) },
  });
});

describe("PersonalConnectionService token validation", () => {
  it.effect("refuses a token the vendor rejects, leaving nothing behind", () => {
    const harness = makeHarness();
    harness.vendor.reject = "unauthorized";
    return Effect.gen(function* () {
      const error = yield* Effect.flip(connectGithub);
      expect(error.message).toContain("GitHub");
      // A token that cannot work is not a connection, so neither the row nor
      // the stored value survives the attempt.
      expect(harness.rows.size).toBe(0);
      expect(harness.secrets.size).toBe(0);
      expect(error.message).not.toContain(TOKEN);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("names the required scopes a short token is missing", () => {
    const harness = makeHarness();
    harness.vendor.grantedScopes = ["repo"];
    return Effect.gen(function* () {
      const error = yield* Effect.flip(connectGithub);
      expect(error.message).toContain("workflow");
      expect(harness.rows.size).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("connects a token whose scopes the vendor will not report", () => {
    const harness = makeHarness();
    // A fine-grained GitHub PAT sends no scope header. Refusing it would turn
    // away the token type GitHub recommends and the one a beginner is steered
    // to, to satisfy a header it deliberately omits. Capabilities gate no
    // operation, so connecting proves only identity; the first write that the
    // token cannot do fails against GitHub with a reason worth reading.
    harness.vendor.grantedScopes = null;
    return Effect.gen(function* () {
      const created = yield* connectGithub;
      expect(created.status).toBe("connected");
      expect(created.account).toEqual(ACCOUNT);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("still refuses a token the vendor says is short a scope", () => {
    const harness = makeHarness();
    harness.vendor.grantedScopes = ["repo"];
    return Effect.gen(function* () {
      const error = yield* Effect.flip(connectGithub);
      expect(error.message).toContain("workflow");
      expect(harness.rows.size).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("records the account and the capabilities the vendor confirmed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const created = yield* connectGithub;
      expect(created.status).toBe("connected");
      expect(created.account).toEqual(ACCOUNT);
      // Deduplicated: the adapter reported the same capability twice.
      expect(created.verifiedCapabilities).toEqual(["github.create_repository"]);
      expect(created.lastValidatedAt).not.toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("moves a live connection to needs_reauth when the token stops being accepted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.PersonalConnectionService;
      const created = yield* connectGithub;
      expect(Option.isSome(yield* service.resolveForOperation("github"))).toBe(true);

      // What a PAT reaching GitHub's expiry date looks like from here.
      harness.vendor.reject = "unauthorized";
      const revalidated = yield* service.validate({ connectionId: created.connectionId });
      expect(revalidated.connection.status).toBe("needs_reauth");
      expect(revalidated.problem).not.toBeNull();
      expect(revalidated.problem ?? "").not.toContain(TOKEN);
      // A connection in that state runs nothing until the owner replaces it.
      expect(Option.isNone(yield* service.resolveForOperation("github"))).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("separates a provider we could not reach from a token it refused", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.PersonalConnectionService;
      const created = yield* connectGithub;
      harness.vendor.reject = "offline";
      const result = yield* service.validate({ connectionId: created.connectionId });
      // Not needs_reauth: nothing was learned about the token, and telling the
      // owner to mint a new one would be a guess dressed as an instruction.
      expect(result.connection.status).toBe("error");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports a missing scope on revalidation without discarding the connection", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.PersonalConnectionService;
      const created = yield* connectGithub;
      harness.vendor.grantedScopes = ["repo"];
      const result = yield* service.validate({ connectionId: created.connectionId });
      expect(result.missingScopes).toEqual(["workflow"]);
      expect(result.connection.status).toBe("needs_reauth");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the working credential when a replacement fails validation", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.PersonalConnectionService;
      const created = yield* connectGithub;
      harness.vendor.reject = "unauthorized";
      yield* Effect.flip(
        service.rotate({
          connectionId: created.connectionId,
          credentials: { accessToken: Redacted.make("worse-token") },
        }),
      );
      harness.vendor.reject = "none";
      const current = Option.getOrThrow(yield* service.resolveForOperation("github"));
      expect(current.credentialVersion).toBe(1);
      expect(harness.secrets.size).toBe(1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("stores a vendor it cannot check yet without claiming it is connected", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.PersonalConnectionService;
      const created = yield* service.connect({
        vendorId: "neon",
        credentials: { apiKey: Redacted.make("neon-key") },
      });
      // No adapter means no proof, and "connecting" is the honest word for it.
      expect(created.status).toBe("connecting");
      expect(Option.isNone(yield* service.resolveForOperation("neon"))).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("marks a connection for reauth when a live call is refused", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.PersonalConnectionService;
      const created = yield* connectGithub;
      yield* service.markNeedsReauth(created.connectionId);
      expect(harness.rows.get(created.connectionId)?.status).toBe("needs_reauth");

      // Disabled is the owner's decision and outranks a vendor's 401: coming
      // back as needs_reauth would quietly re-offer a connection they turned off.
      yield* service.reconnect({ connectionId: created.connectionId });
      yield* service.disable({ connectionId: created.connectionId });
      yield* service.markNeedsReauth(created.connectionId);
      expect(harness.rows.get(created.connectionId)?.status).toBe("disabled");
    }).pipe(Effect.provide(harness.layer));
  });
});
