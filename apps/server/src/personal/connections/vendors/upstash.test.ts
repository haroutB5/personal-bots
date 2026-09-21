import { ConnectionId } from "@t3tools/contracts";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { operationsForVendor } from "../operations.ts";
import { makeUpstashAdapter } from "./upstash.ts";
import { VERCEL_VENDOR_SCHEMAS } from "./vercel.ts";
import { makeFetchVendorHttp, type VendorHttp, type VendorHttpRequest } from "./vendorHttp.ts";

const EMAIL = "harout@example.com";
const API_KEY = "upstash_fake_APIKEY_value_0123456789";
const VERCEL_TOKEN = "vercel_fake_TOKEN_value_0123456789";
const REST_TOKEN = "AX9fAAIncDE0fake_REST_TOKEN_999";

const credentials = { email: Redacted.make(EMAIL), apiKey: Redacted.make(API_KEY) };
const secondary = {
  vendorId: "vercel" as const,
  credentials: { accessToken: Redacted.make(VERCEL_TOKEN) },
  account: { accountId: "u1", accountName: "harout", teamId: "team_abc", teamName: "Harout" },
};

/** One connection stands for the account under test. */
const CONNECTION = ConnectionId.make("connection-under-test");

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
    Effect.sync(() => {
      requests.push(request);
      const route = routes[`${request.method} ${request.url}`];
      if (route === undefined) {
        return {
          status: 599,
          body: `no route for ${request.method} ${request.url}`,
          headers: {},
        };
      }
      return { status: route.status ?? 200, body: route.body ?? null, headers: {} };
    });
  return { requests, adapter: makeUpstashAdapter(http) };
};

const DATABASE = {
  database_id: "d1e2f3a4-0000-4a1b-9c2d-000000000000",
  database_name: "hbots_demo_cache",
  primary_region: "eu-west-1",
  endpoint: "eu1-fake-bird-12345.upstash.io",
  port: 6379,
  state: "active",
  password: "fake_redis_PASSWORD_999",
  rest_token: REST_TOKEN,
  read_only_rest_token: "Ao9fAAIgcDE0readonly_fake",
};

describe("upstash adapter", () => {
  it.effect(
    "speaks exactly the vendor shape every upstash operation it implements was reviewed against",
    () =>
      Effect.gen(function* () {
        const { adapter } = harness({});
        for (const operation of operationsForVendor("upstash")) {
          const spoken = yield* adapter.vendorSchema(operation.operationId).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          );
          if (!spoken.ok) {
            // A generic Redis command needs the database's own REST token,
            // which is an application credential this build deliberately only
            // ever moves into a Vercel environment. Refused by name.
            expect(operation.operationId, spoken.error.detail).toBe("upstash.redis_command");
            continue;
          }
          expect(spoken.value, operation.operationId).toBe(operation.reviewedVendorSchema);
        }
      }),
  );

  it.effect("pins the Vercel half of the transfer to what the Vercel adapter itself speaks", () =>
    Effect.gen(function* () {
      const { adapter } = harness({});
      const spoken = yield* adapter.vendorSchema("upstash.attach_rest_credentials_to_vercel");
      expect(spoken.endsWith(`+${VERCEL_VENDOR_SCHEMAS["vercel.set_environment_variables"]}`)).toBe(
        true,
      );
    }),
  );

  it.effect("sends the email and the API key as separate halves of one basic credential", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://api.upstash.com/v2/redis/databases": { body: [DATABASE] },
      });
      yield* adapter.validate(credentials);
      const sent = requests[0];
      expect(sent?.bearer).toBeUndefined();
      expect(Redacted.value(sent?.basic?.username ?? Redacted.make(""))).toBe(EMAIL);
      expect(Redacted.value(sent?.basic?.password ?? Redacted.make(""))).toBe(API_KEY);
      // The pair is joined in exactly one place, and it is not here.
      expect(text([sent?.url, sent?.body])).not.toContain(API_KEY);
    }),
  );

  it.effect("builds the basic header at the HTTP seam and nowhere else", () =>
    Effect.gen(function* () {
      let sentHeaders: Record<string, string> = {};
      const fetchImpl = ((_url: string, init: { headers: Record<string, string> }) => {
        sentHeaders = init.headers;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as unknown as typeof globalThis.fetch;
      yield* makeFetchVendorHttp(fetchImpl)({
        operationId: "upstash.list_databases",
        method: "GET",
        url: "https://api.upstash.com/v2/redis/databases",
        basic: { username: Redacted.make(EMAIL), password: Redacted.make(API_KEY) },
      });
      expect(sentHeaders["authorization"]).toBe(
        `Basic ${Buffer.from(`${EMAIL}:${API_KEY}`, "utf8").toString("base64")}`,
      );
    }),
  );

  it.effect("refuses to send a request that was built with no credential at all", () =>
    Effect.gen(function* () {
      const fetchImpl = (() => {
        throw new Error("a request with no credential must not reach the network");
      }) as unknown as typeof globalThis.fetch;
      const error = yield* Effect.flip(
        makeFetchVendorHttp(fetchImpl)({
          operationId: "upstash.list_databases",
          method: "GET",
          url: "https://api.upstash.com/v2/redis/databases",
        }),
      );
      expect(error.detail).toContain("no credential");
    }),
  );

  it.effect("lists databases without their credentials", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://api.upstash.com/v2/redis/databases": { body: [DATABASE] },
      });
      const result = yield* adapter.execute({
        operationId: "upstash.list_databases",
        arguments: {},
        credentials,
        connectionId: CONNECTION,
        settings: { whatsappDailySendCap: null },
        account: null,
      });
      expect(result).toEqual({
        databases: [
          {
            database: "hbots_demo_cache",
            databaseId: "d1e2f3a4-0000-4a1b-9c2d-000000000000",
            primaryRegion: "eu-west-1",
          },
        ],
      });
      expect(text(result)).not.toContain(REST_TOKEN);
      expect(text(result)).not.toContain("fake_redis_PASSWORD_999");
    }),
  );

  it.effect("marks a rejected API key as unauthorized", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://api.upstash.com/v2/redis/databases": { status: 401, body: "Unauthorized" },
      });
      const error = yield* Effect.flip(adapter.validate(credentials));
      expect(error.unauthorized).toBe(true);
      expect(text(error)).not.toContain(API_KEY);
    }),
  );

  it.effect("creates a database on the named plan and region and returns no token", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "POST https://api.upstash.com/v2/redis/database": { body: DATABASE },
      });
      const result = yield* adapter.execute({
        operationId: "upstash.create_redis_database",
        arguments: { name: "hbots_demo_cache", primaryRegion: "eu-west-1", plan: "free" },
        credentials,
        connectionId: CONNECTION,
        settings: { whatsappDailySendCap: null },
        account: null,
      });
      expect(requests[0]?.body).toEqual({
        database_name: "hbots_demo_cache",
        platform: "aws",
        primary_region: "eu-west-1",
        plan: "free",
        tls: true,
      });
      expect(result).toEqual({
        database: "hbots_demo_cache",
        databaseId: "d1e2f3a4-0000-4a1b-9c2d-000000000000",
        primaryRegion: "eu-west-1",
        plan: "free",
      });
      // The create reply carries the REST token and the Redis password.
      expect(text(result)).not.toContain(REST_TOKEN);
      expect(text(result)).not.toContain("fake_redis_PASSWORD_999");
    }),
  );

  it.effect("proves the id is the database the owner approved before deleting it", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://api.upstash.com/v2/redis/database/d1e2f3a4-0000-4a1b-9c2d-000000000000?credentials=hide":
          { body: { ...DATABASE, database_name: "something-else" } },
      });
      const error = yield* Effect.flip(
        adapter.execute({
          operationId: "upstash.delete_database",
          arguments: {
            databaseId: "d1e2f3a4-0000-4a1b-9c2d-000000000000",
            database: "hbots_demo_cache",
          },
          credentials,
          connectionId: CONNECTION,
          settings: { whatsappDailySendCap: null },
          account: null,
        }),
      );
      expect(error.detail).toContain("something-else");
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    }),
  );

  it.effect("deletes the database once the name matches", () =>
    Effect.gen(function* () {
      const { adapter, requests } = harness({
        "GET https://api.upstash.com/v2/redis/database/d1e2f3a4-0000-4a1b-9c2d-000000000000?credentials=hide":
          { body: { ...DATABASE, rest_token: undefined, password: undefined } },
        "DELETE https://api.upstash.com/v2/redis/database/d1e2f3a4-0000-4a1b-9c2d-000000000000": {
          body: "OK",
        },
      });
      const result = yield* adapter.execute({
        operationId: "upstash.delete_database",
        arguments: {
          databaseId: "d1e2f3a4-0000-4a1b-9c2d-000000000000",
          database: "hbots_demo_cache",
        },
        credentials,
        connectionId: CONNECTION,
        settings: { whatsappDailySendCap: null },
        account: null,
      });
      expect(result).toEqual({ database: "hbots_demo_cache", deleted: true });
      expect(requests[1]?.method).toBe("DELETE");
      // Reading a database to confirm its name does not need its credentials.
      expect(requests[0]?.url).toContain("credentials=hide");
    }),
  );
});

describe("upstash server-side credential transfer", () => {
  const transfer = {
    operationId: "upstash.attach_rest_credentials_to_vercel",
    arguments: {
      databaseId: "d1e2f3a4-0000-4a1b-9c2d-000000000000",
      database: "hbots_demo_cache",
      vercelProject: "hbots-demo",
      target: "production",
      urlVariableName: "UPSTASH_REDIS_REST_URL",
      tokenVariableName: "UPSTASH_REDIS_REST_TOKEN",
    },
    credentials,
    connectionId: CONNECTION,
    settings: { whatsappDailySendCap: null },
    account: null,
  };

  const transferHarness = (database: Readonly<Record<string, unknown>> = DATABASE) =>
    harness({
      "GET https://api.upstash.com/v2/redis/database/d1e2f3a4-0000-4a1b-9c2d-000000000000": {
        body: database,
      },
      "POST https://api.vercel.com/v10/projects/hbots-demo/env?upsert=true&teamId=team_abc": {
        body: { created: [{ id: "env_1", key: "UPSTASH_REDIS_REST_TOKEN", value: REST_TOKEN }] },
      },
    });

  it.effect("moves the REST URL and token into Vercel and returns only the names", () =>
    Effect.gen(function* () {
      const { adapter, requests } = transferHarness();
      const result = yield* adapter.execute({ ...transfer, secondary });
      expect(result).toEqual({
        vercelProject: "hbots-demo",
        target: "production",
        keys: ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
      });
      expect(text(result)).not.toContain(REST_TOKEN);
      expect(requests[1]?.body).toEqual([
        {
          key: "UPSTASH_REDIS_REST_URL",
          value: "https://eu1-fake-bird-12345.upstash.io",
          type: "encrypted",
          target: ["production"],
        },
        {
          key: "UPSTASH_REDIS_REST_TOKEN",
          value: REST_TOKEN,
          type: "encrypted",
          target: ["production"],
        },
      ]);
      expect(text(requests.map((request) => request.url))).not.toContain(REST_TOKEN);
    }),
  );

  it.effect("uses each connection's own credential and never crosses them", () =>
    Effect.gen(function* () {
      const { adapter, requests } = transferHarness();
      yield* adapter.execute({ ...transfer, secondary });
      // The account-level management key talks to Upstash; the Vercel token
      // talks to Vercel. The application REST token is neither, and is the
      // thing being moved.
      expect(Redacted.value(requests[0]?.basic?.password ?? Redacted.make(""))).toBe(API_KEY);
      expect(Redacted.value(requests[1]?.bearer ?? Redacted.make(""))).toBe(VERCEL_TOKEN);
      expect(requests[1]?.basic).toBeUndefined();
    }),
  );

  it.effect("refuses the transfer when no Vercel connection was supplied", () =>
    Effect.gen(function* () {
      const { adapter, requests } = transferHarness();
      const error = yield* Effect.flip(adapter.execute(transfer));
      expect(error.detail).toContain("Vercel");
      expect(requests).toEqual([]);
    }),
  );

  it.effect("refuses the transfer when the database it names is not the one at that id", () =>
    Effect.gen(function* () {
      const { adapter, requests } = transferHarness({
        ...DATABASE,
        database_name: "someone-elses-cache",
      });
      const error = yield* Effect.flip(adapter.execute({ ...transfer, secondary }));
      expect(error.detail).toContain("someone-elses-cache");
      // The secret was read to check, and no write followed it.
      expect(requests.every((request) => request.url.startsWith("https://api.upstash.com"))).toBe(
        true,
      );
    }),
  );

  it.effect("completes the host when Upstash answers with a bare endpoint slug", () =>
    Effect.gen(function* () {
      // Upstash's own schema says `endpoint` may be a slug or a full host.
      const { adapter, requests } = transferHarness({
        ...DATABASE,
        endpoint: "beloved-stallion-58500",
      });
      yield* adapter.execute({ ...transfer, secondary });
      const written = requests[1]?.body as ReadonlyArray<{ key: string; value: string }>;
      expect(written[0]?.value).toBe("https://beloved-stallion-58500.upstash.io");
    }),
  );

  it.effect("stops when Upstash returns a database with no REST token to move", () =>
    Effect.gen(function* () {
      const { adapter, requests } = transferHarness({ ...DATABASE, rest_token: "" });
      const error = yield* Effect.flip(adapter.execute({ ...transfer, secondary }));
      expect(error.detail).toContain("REST");
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect("keeps the REST token out of a failed write's error", () =>
    Effect.gen(function* () {
      const { adapter } = harness({
        "GET https://api.upstash.com/v2/redis/database/d1e2f3a4-0000-4a1b-9c2d-000000000000": {
          body: DATABASE,
        },
        "POST https://api.vercel.com/v10/projects/hbots-demo/env?upsert=true&teamId=team_abc": {
          status: 400,
          body: { error: { message: `Invalid value: ${REST_TOKEN}` } },
        },
      });
      const error = yield* Effect.flip(adapter.execute({ ...transfer, secondary }));
      expect(error.detail).toContain("Invalid value");
      expect(text(error)).not.toContain(REST_TOKEN);
      expect(text(error)).not.toContain(API_KEY);
      expect(text(error)).not.toContain(VERCEL_TOKEN);
    }),
  );
});
