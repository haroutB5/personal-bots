import { ConnectionId, PersonalConnectionsError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import * as Adapters from "./adapters.ts";
import * as CredentialStore from "./credentialStore.ts";
import * as Repository from "./repository.ts";
import * as Service from "./service.ts";

const TOKEN = "fake-token-must-never-escape";
const at = DateTime.makeUnsafe("2026-09-20T10:00:00.000Z");

interface Harness {
  readonly layer: Layer.Layer<Service.PersonalConnectionService>;
  readonly rows: Map<string, Repository.StoredPersonalConnection>;
  readonly secrets: Map<string, Readonly<Record<string, Redacted.Redacted<string>>>>;
  /** Tokens the fake vendor accepts, and what it says they may do. */
  readonly vendor: {
    grantedScopes: ReadonlyArray<string> | null;
    reject: "none" | "unauthorized" | "offline";
  };
}

const ACCOUNT = {
  accountId: "account-1",
  accountName: "Octocat",
  teamId: null,
  teamName: null,
};

const makeHarness = (options?: { readonly failCreate?: boolean }): Harness => {
  const vendor = {
    grantedScopes: ["repo", "workflow"] as ReadonlyArray<string> | null,
    reject: "none" as "none" | "unauthorized" | "offline",
  };
  const rows = new Map<string, Repository.StoredPersonalConnection>();
  const secrets = new Map<string, Readonly<Record<string, Redacted.Redacted<string>>>>();
  let sequence = 0;

  const repository = Repository.PersonalConnectionRepository.of({
    list: () => Effect.succeed([...rows.values()]),
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(rows.get(connectionId))),
    getByVendor: (vendorId) =>
      Effect.succeed(
        Option.fromNullishOr([...rows.values()].find((row) => row.vendorId === vendorId)),
      ),
    create: (row) =>
      options?.failCreate
        ? Effect.fail(new PersistenceSqlError({ operation: "test.create" }))
        : Effect.sync(() => {
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
        const handle = {
          credentialRef: `opaque-${++sequence}`,
          version: previous.version + 1,
        };
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
              // The vendor quotes our own request back at us, token included.
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
      Layer.provide(Adapters.layerOf([github])),
      Layer.provide(Layer.succeed(Repository.PersonalConnectionRepository, repository)),
      Layer.provide(
        Layer.succeed(CredentialStore.PersonalConnectionCredentialStore, credentialStore),
      ),
    ),
  };
};

describe("PersonalConnectionService", () => {
  it.effect("makes every status transition explicit and rotation visible to resolution", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.PersonalConnectionService;
      const created = yield* service.connect({
        vendorId: "github",
        credentials: { accessToken: Redacted.make(TOKEN) },
      });
      // Connecting validates: a stored token nobody called is a token that
      // fails in the middle of somebody's task instead of on this screen.
      expect(created.status).toBe("connected");
      expect(created.credentialVersion).toBe(1);

      const connected = (yield* service.validate({ connectionId: created.connectionId }))
        .connection;
      expect(connected.status).toBe("connected");
      expect(connected.lastValidatedAt).not.toBeNull();
      expect(
        Option.getOrThrow(yield* service.resolveForOperation("github")).credentialVersion,
      ).toBe(1);

      expect((yield* service.disable({ connectionId: created.connectionId })).status).toBe(
        "disabled",
      );
      expect(Option.isNone(yield* service.resolveForOperation("github"))).toBe(true);

      expect((yield* service.reconnect({ connectionId: created.connectionId })).status).toBe(
        "connecting",
      );
      harness.vendor.reject = "unauthorized";
      expect(
        (yield* service.validate({ connectionId: created.connectionId })).connection.status,
      ).toBe("needs_reauth");
      harness.vendor.reject = "none";

      yield* service.reconnect({ connectionId: created.connectionId });
      const rotated = yield* service.rotate({
        connectionId: created.connectionId,
        credentials: { accessToken: Redacted.make("replacement-token") },
      });
      expect(rotated.status).toBe("connected");
      expect(rotated.credentialVersion).toBe(2);

      expect(
        Option.getOrThrow(yield* service.resolveForOperation("github")).credentialVersion,
      ).toBe(2);

      const disconnected = yield* service.disconnect({
        connectionId: created.connectionId,
      });
      expect(disconnected).toEqual({ disconnected: true });
      expect((yield* service.list()).connections).toEqual([]);
      expect(harness.secrets.size).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("removes a newly stored credential when the connection row cannot be written", () => {
    const harness = makeHarness({ failCreate: true });
    return Effect.gen(function* () {
      const service = yield* Service.PersonalConnectionService;
      const error = yield* service
        .connect({
          vendorId: "github",
          credentials: { accessToken: Redacted.make(TOKEN) },
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(PersonalConnectionsError);
      expect(harness.rows.size).toBe(0);
      expect(harness.secrets.size).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("never includes a credential in list results, logs or errors", () => {
    const harness = makeHarness();
    const messages: unknown[] = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(message);
    });
    return Effect.gen(function* () {
      const service = yield* Service.PersonalConnectionService;
      yield* service.connect({
        vendorId: "github",
        credentials: { accessToken: Redacted.make(TOKEN) },
      });
      const list = yield* service.list();
      const error = yield* service
        .connect({
          vendorId: "github",
          credentials: { accessToken: Redacted.make(TOKEN) },
        })
        .pipe(Effect.flip);

      // The point of a leak assertion is to serialize whatever shape the value
      // actually has, including an error and a log record no schema describes.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.stringify(list)).not.toContain(TOKEN);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.stringify(messages)).not.toContain(TOKEN);
      expect(list.connections[0]).not.toHaveProperty("credentialRef");
    }).pipe(
      Effect.provide(harness.layer),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });

  it.effect("refuses invalid transitions without changing persisted state", () => {
    const harness = makeHarness();
    const connectionId = ConnectionId.make("connection-connected");
    harness.rows.set(connectionId, {
      connectionId,
      vendorId: "github",
      status: "connected",
      account: null,
      verifiedCapabilities: [],
      credentialRef: "opaque-existing",
      credentialVersion: 1,
      lastValidatedAt: at,
      createdAt: at,
      updatedAt: at,
    });
    return Effect.gen(function* () {
      const service = yield* Service.PersonalConnectionService;
      const error = yield* service.reconnect({ connectionId }).pipe(Effect.flip);
      expect(error.message).toContain("cannot reconnect while connected");
      expect(harness.rows.get(connectionId)?.status).toBe("connected");
    }).pipe(Effect.provide(harness.layer));
  });
});
