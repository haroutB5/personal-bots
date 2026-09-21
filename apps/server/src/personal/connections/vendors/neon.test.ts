import * as NodeUtil from "node:util";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { operationsForVendor } from "../operations.ts";
import { makeNeonAdapter } from "./neon.ts";
import { VERCEL_VENDOR_SCHEMAS } from "./vercel.ts";
import type { VendorHttp, VendorHttpRequest, VendorHttpResponse } from "./vendorHttp.ts";

const API_KEY = "neon_fake_APIKEY_value_0123456789";
const VERCEL_TOKEN = "vercel_fake_TOKEN_value_0123456789";
/** The thing this milestone exists to keep out of every model-facing surface. */
const CONNECTION_STRING =
  "postgresql://neondb_owner:npg_fakeSECRET9999@ep-cool-bird-123.eu-west-2.aws.neon.tech/neondb?sslmode=require";

const credentials = { apiKey: Redacted.make(API_KEY) };
const VERCEL_ACCOUNT = {
  accountId: "u1",
  accountName: "harout",
  teamId: "team_abc",
  teamName: "Harout",
};
const secondary = {
  vendorId: "vercel" as const,
  credentials: { accessToken: Redacted.make(VERCEL_TOKEN) },
  account: VERCEL_ACCOUNT,
};

const text = (value: unknown) =>
  NodeUtil.inspect(value, {
    depth: null,
    breakLength: Infinity,
    maxArrayLength: null,
    maxStringLength: null,
  });

interface Route {
  readonly status?: number;
  readonly body?: unknown;
}

const harness = (routes: Readonly<Record<string, Route>>) => {
  const requests: Array<VendorHttpRequest> = [];
  const http: VendorHttp = (request) =>
    Effect.sync((): VendorHttpResponse => {
      requests.push(request);
      const route = routes[`${request.method} ${request.url}`];
      if (route === undefined) {
        return {
          status: 599,
          body: { message: `no route for ${request.method} ${request.url}` },
          headers: {},
        };
      }
      return { status: route.status ?? 200, body: route.body ?? null, headers: {} };
    });
  return { requests, adapter: makeNeonAdapter(http) };
};

const CREATED_PROJECT = {
  project: { id: "shiny-wind-028834", name: "hbots-demo", region_id: "aws-eu-west-2" },
  branch: { id: "br-main-1", name: "main" },
  databases: [{ id: 1, name: "neondb", owner_name: "neondb_owner", branch_id: "br-main-1" }],
  roles: [{ name: "neondb_owner", password: "npg_fakeSECRET9999" }],
  // Neon hands back a live connection URI with the reply to a create. It is a
  // password, and no part of it may leave this adapter.
  connection_uris: [{ connection_uri: CONNECTION_STRING }],
};

describe("neon adapter", () => {
  it.effect(
    "speaks exactly the vendor shape every neon operation it implements was reviewed against",
    () =>
      Effect.gen(function* () {
        const { adapter } = harness({});
        for (const operation of operationsForVendor("neon")) {
          const spoken = yield* adapter
            .vendorSchema(operation.operationId)
            .pipe(Effect.map((value) => ({ ok: true as const, value })))
            .pipe(Effect.catch((error) => Effect.succeed({ ok: false as const, error })));
          if (!spoken.ok) {
            // `neon.run_sql` needs a Postgres connection, not the management
            // API, so this build does not speak for it. Saying so by name is
            // the honest state; the gateway refuses it before asking anyone.
            expect(operation.operationId, spoken.error.detail).toBe("neon.run_sql");
            continue;
          }
          expect(spoken.value, operation.operationId).toBe(operation.reviewedVendorSchema);
        }
      }),
  );

  it.effect("pins the Vercel half of the transfer to what the Vercel adapter itself speaks", () =>
    Effect.gen(function* () {
      const { adapter } = harness({});
      const spoken = yield* adapter.vendorSchema("neon.attach_connection_string_to_vercel");
      // Drift at either end is drift. The two halves are stated independently
      // and this is what makes a Vercel contract bump fail here first.
      expect(spoken.endsWith(`+${VERCEL_VENDOR_SCHEMAS["vercel.set_environment_variables"]}`)).toBe(
        true,
      );
    }),
  );

  it.effect("resolves the account an API key belongs to", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://console.neon.tech/api/v2/users/me": {
          body: { id: "user-1", email: "harout@example.com", login: "harout" },
        },
      });
      const validation = yield* adapter.validate(credentials);
      expect(validation.account).toEqual({
        accountId: "user-1",
        accountName: "harout@example.com",
        teamId: null,
        teamName: null,
      });
      expect(validation.verifiedCapabilities).toContain("neon.create_project");
      // Neon reports no scope list, and `null` is "we cannot tell" rather
      // than "this token has none".
      expect(validation.grantedScopes).toBeNull();
      expect(text(requests.map((request) => [request.url, request.body]))).not.toContain(API_KEY);
    }),
  );

  it.effect("marks a rejected API key as unauthorized", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://console.neon.tech/api/v2/users/me": {
          status: 401,
          body: { message: "authorization failed" },
        },
      });
      const error = yield* Effect.flip(adapter.validate(credentials));
      expect(error.unauthorized).toBe(true);
    }),
  );

  it.effect(
    "creates a project and returns no part of the connection string Neon replies with",
    () =>
      Effect.gen(function* () {
        const { adapter, requests } = harness({
          "POST https://console.neon.tech/api/v2/projects": { status: 201, body: CREATED_PROJECT },
        });
        const result = yield* adapter.execute({
          operationId: "neon.create_project",
          arguments: { name: "hbots-demo", regionId: "aws-eu-west-2" },
          credentials,
          account: null,
        });
        expect(requests[0]?.body).toEqual({
          project: { name: "hbots-demo", region_id: "aws-eu-west-2" },
        });
        expect(result).toEqual({
          project: "hbots-demo",
          projectId: "shiny-wind-028834",
          branchId: "br-main-1",
          database: "neondb",
          role: "neondb_owner",
        });
        expect(text(result)).not.toContain("npg_fakeSECRET9999");
        expect(text(result)).not.toContain("neon.tech/neondb");
      }),
  );

  it.effect("creates a database on the named branch", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "POST https://console.neon.tech/api/v2/projects/shiny-wind-028834/branches/br-main-1/databases":
          {
            status: 201,
            body: { database: { name: "app", owner_name: "neondb_owner", branch_id: "br-main-1" } },
          },
      });
      const result = yield* adapter.execute({
        operationId: "neon.create_database",
        arguments: {
          project: "shiny-wind-028834",
          branch: "br-main-1",
          name: "app",
          ownerRole: "neondb_owner",
        },
        credentials,
        account: null,
      });
      expect(requests[0]?.body).toEqual({ database: { name: "app", owner_name: "neondb_owner" } });
      expect(result).toEqual({
        project: "shiny-wind-028834",
        branch: "br-main-1",
        database: "app",
        owner: "neondb_owner",
      });
    }),
  );

  it.effect("proves the project id is the project the owner approved before deleting it", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://console.neon.tech/api/v2/projects/shiny-wind-028834": {
          body: { project: { id: "shiny-wind-028834", name: "something-else" } },
        },
      });
      const error = yield* Effect.flip(
        adapter.execute({
          operationId: "neon.delete_project",
          arguments: { project: "shiny-wind-028834", name: "hbots-demo" },
          credentials,
          account: null,
        }),
      );
      expect(error.detail).toContain("something-else");
      // The owner approved deleting a name. Nothing was deleted.
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    }),
  );

  it.effect("deletes the project once the name matches", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://console.neon.tech/api/v2/projects/shiny-wind-028834": {
          body: { project: { id: "shiny-wind-028834", name: "hbots-demo" } },
        },
        "DELETE https://console.neon.tech/api/v2/projects/shiny-wind-028834": {
          body: { project: { id: "shiny-wind-028834", name: "hbots-demo" } },
        },
      });
      const result = yield* adapter.execute({
        operationId: "neon.delete_project",
        arguments: { project: "shiny-wind-028834", name: "hbots-demo" },
        credentials,
        account: null,
      });
      expect(result).toEqual({ project: "hbots-demo", deleted: true });
      expect(requests[1]?.method).toBe("DELETE");
    }),
  );
});

describe("neon server-side credential transfer", () => {
  const transfer = {
    operationId: "neon.attach_connection_string_to_vercel",
    arguments: {
      project: "shiny-wind-028834",
      branch: "br-main-1",
      database: "neondb",
      role: "neondb_owner",
      pooled: true,
      vercelProject: "hbots-demo",
      target: "production",
      variableName: "DATABASE_URL",
    },
    credentials,
    account: null,
  };

  const transferHarness = () =>
    harness({
      "GET https://console.neon.tech/api/v2/projects/shiny-wind-028834/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=true&branch_id=br-main-1":
        { body: { uri: CONNECTION_STRING } },
      "POST https://api.vercel.com/v10/projects/hbots-demo/env?upsert=true&teamId=team_abc": {
        body: { created: [{ id: "env_1", key: "DATABASE_URL", value: CONNECTION_STRING }] },
      },
    });

  it.effect("moves the connection string from Neon into Vercel and returns only the names", () =>
    Effect.gen(function* () {
      const { adapter, requests } = transferHarness();
      const result = yield* adapter.execute({ ...transfer, secondary });
      expect(result).toEqual({
        vercelProject: "hbots-demo",
        target: "production",
        keys: ["DATABASE_URL"],
      });
      // The value exists exactly once on the wire: in the body of the write
      // that puts it where it is used.
      expect(text(result)).not.toContain("npg_fakeSECRET9999");
      expect(requests).toHaveLength(2);
      expect(requests[1]?.body).toEqual([
        {
          key: "DATABASE_URL",
          value: CONNECTION_STRING,
          type: "encrypted",
          target: ["production"],
        },
      ]);
      // It is never in a URL, where it would reach a log or a proxy.
      expect(text(requests.map((request) => request.url))).not.toContain("npg_fakeSECRET9999");
    }),
  );

  it.effect("uses each connection's own credential and never crosses them", () =>
    Effect.gen(function* () {
      const { adapter, requests } = transferHarness();
      yield* adapter.execute({ ...transfer, secondary });
      // The account-level provisioning key talks to Neon; the Vercel token
      // talks to Vercel. Neither is ever presented to the other provider.
      expect(Redacted.value(requests[0]?.bearer ?? Redacted.make(""))).toBe(API_KEY);
      expect(Redacted.value(requests[1]?.bearer ?? Redacted.make(""))).toBe(VERCEL_TOKEN);
    }),
  );

  it.effect("leaves the branch out when the caller named none, so Neon uses the default", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://console.neon.tech/api/v2/projects/shiny-wind-028834/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=false":
          { body: { uri: CONNECTION_STRING } },
        "POST https://api.vercel.com/v10/projects/hbots-demo/env?upsert=true&teamId=team_abc": {
          body: {},
        },
      });
      yield* adapter.execute({
        ...transfer,
        arguments: { ...transfer.arguments, branch: null, pooled: false },
        secondary,
      });
      expect(requests[0]?.url).not.toContain("branch_id");
    }),
  );

  it.effect(
    "refuses the transfer when no Vercel connection was supplied, rather than half-doing it",
    () =>
      Effect.gen(function* () {
        const { adapter, requests } = transferHarness();
        // Production supplies this from the gateway. If it ever stops, the
        // transfer must stop with it rather than fetch a secret it cannot place.
        const error = yield* Effect.flip(adapter.execute(transfer));
        expect(error.detail).toContain("Vercel");
        expect(requests).toEqual([]);
      }),
  );

  it.effect("refuses a second connection that is not the Vercel one", () =>
    Effect.gen(function* () {
      const { adapter, requests } = transferHarness();
      const error = yield* Effect.flip(
        adapter.execute({ ...transfer, secondary: { ...secondary, vendorId: "github" } }),
      );
      expect(error.detail).toContain("Vercel");
      expect(requests).toEqual([]);
    }),
  );

  it.effect("keeps the connection string out of a failed write's error", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://console.neon.tech/api/v2/projects/shiny-wind-028834/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=true&branch_id=br-main-1":
          { body: { uri: CONNECTION_STRING } },
        "POST https://api.vercel.com/v10/projects/hbots-demo/env?upsert=true&teamId=team_abc": {
          status: 400,
          // A provider that quotes the request back is the normal case, not
          // the exotic one.
          body: { error: { message: `Invalid value for DATABASE_URL: ${CONNECTION_STRING}` } },
        },
      });
      const error = yield* Effect.flip(adapter.execute({ ...transfer, secondary }));
      expect(error.detail).toContain("Invalid value");
      expect(text(error)).not.toContain("npg_fakeSECRET9999");
      expect(text(error)).not.toContain(VERCEL_TOKEN);
      expect(text(error)).not.toContain(API_KEY);
    }),
  );

  it.effect("stops before writing anything when Neon will not give the connection string", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://console.neon.tech/api/v2/projects/shiny-wind-028834/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=true&branch_id=br-main-1":
          { status: 404, body: { message: "database not found" } },
      });
      const error = yield* Effect.flip(adapter.execute({ ...transfer, secondary }));
      expect(error.detail).toContain("not found");
      expect(requests.every((request) => request.url.startsWith("https://console.neon.tech"))).toBe(
        true,
      );
    }),
  );
});
