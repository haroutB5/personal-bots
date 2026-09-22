// @effect-diagnostics preferSchemaOverJson:off - quoting a vendor's own error body back, not decoding a known shape.
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import {
  ConnectionVendorError,
  type ConnectionVendorAdapter,
  type ConnectionVendorCall,
} from "../adapters.ts";
import { scrubCredentialValues } from "../operations.ts";
import { setVercelEnvironmentVariables } from "./vercel.ts";
import {
  expectOk,
  isUnauthorizedStatus,
  vendorFailure,
  type VendorHttp,
  type VendorHttpRequest,
} from "./vendorHttp.ts";

/**
 * Upstash over its developer (management) REST API.
 *
 * Not the official Upstash MCP server, after reading what it covers. That
 * server is aimed at IDE and agent-driven development — its own documentation
 * steers most workflows to the Upstash skill driving `@upstash/cli` instead —
 * and it exposes a much wider surface than provisioning, including Upstash Box
 * tools that read, write and execute. It also expects to hold the account
 * email and API key itself, in a process the model drives, which is the
 * arrangement this whole design exists to replace: here the credential stays
 * on the server and every call is a reviewed operation with its own argument
 * schema and risk classification. A handful of narrow REST calls keeps all of
 * that, so the REST API wins.
 *
 * `upstash.redis_command` is deliberately absent from the table below. Running
 * a command needs the database's own REST token, which is an application
 * credential this build only ever moves into a Vercel environment, never
 * holds open for a bot. The gateway refuses an operation this adapter does not
 * speak for, by name, before asking the owner anything.
 */

const API = "https://api.upstash.com/v2";

const VENDOR_SCHEMAS: Readonly<Record<string, string>> = {
  "upstash.list_databases": "upstash/v2-databases@2026-09-20",
  "upstash.create_redis_database": "upstash/v2-redis-database@2026-09-21",
  "upstash.delete_database": "upstash/v2-redis-database-delete@2026-09-21",
  // Both halves, because drift at either end is drift. The Vercel half is
  // stated here independently of `vercel.ts`; the test compares them.
  "upstash.attach_rest_credentials_to_vercel":
    "upstash/v2-redis-database@2026-09-21+vercel/v10-project-env@2026-09-20",
};

const IMPLEMENTED = Object.keys(VENDOR_SCHEMAS);

/**
 * Upstash creates in one cloud. `aws` is where the owner's existing databases
 * live, and a platform argument would be a second thing for the owner to
 * approve without changing what they get.
 */
const PLATFORM = "aws";

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

/** Path segments come from `ResourceName`, which has no slash; encoding is belt and braces. */
const segment = (value: string) => encodeURIComponent(value);

/**
 * Upstash reports `endpoint` as either a full host or a bare slug, and says so
 * in its own schema. Guessing wrong writes an unreachable URL into a live
 * environment, so both forms are handled rather than one assumed.
 */
const restUrl = (endpoint: string) =>
  endpoint.includes(".") ? `https://${endpoint}` : `https://${endpoint}.upstash.io`;

export const makeUpstashAdapter = (http: VendorHttp): ConnectionVendorAdapter => {
  /**
   * The two halves of the management credential, kept separate all the way to
   * the HTTP seam that builds the header.
   */
  const basic = (call: Pick<ConnectionVendorCall, "credentials" | "operationId">) => {
    const email = call.credentials["email"];
    const apiKey = call.credentials["apiKey"];
    return email === undefined || apiKey === undefined
      ? Effect.fail(
          vendorFailure(
            call.operationId,
            "The Upstash connection is missing its account email or API key.",
          ),
        )
      : Effect.succeed({ username: email, password: apiKey });
  };

  const send = (request: VendorHttpRequest) =>
    http(request).pipe(Effect.flatMap((response) => expectOk(request.operationId, response)));

  /** Reads one database, optionally without asking Upstash for its credentials. */
  const readDatabase = Effect.fn("upstash.readDatabase")(function* (input: {
    readonly operationId: string;
    readonly credential: {
      readonly username: Redacted.Redacted<string>;
      readonly password: Redacted.Redacted<string>;
    };
    readonly databaseId: string;
    readonly withCredentials: boolean;
  }) {
    return asRecord(
      yield* send({
        operationId: input.operationId,
        method: "GET",
        url: `${API}/redis/database/${segment(input.databaseId)}${input.withCredentials ? "" : "?credentials=hide"}`,
        basic: input.credential,
      }),
    );
  });

  /**
   * Refuses unless the id really is the database the owner approved by name.
   * An approval binds to an id; the owner read a name.
   */
  const requireName = (
    operationId: string,
    database: Readonly<Record<string, unknown>>,
    expected: string,
  ): Effect.Effect<string, ConnectionVendorError> => {
    const actual = asString(database["database_name"]);
    return actual === expected
      ? Effect.succeed(actual)
      : Effect.fail(
          vendorFailure(
            operationId,
            `That Upstash database is called ${actual}, not ${expected}, so nothing was done to it. Check which database you meant.`,
          ),
        );
  };

  /**
   * Fetches the database's REST credentials and writes them into a Vercel
   * environment without either value leaving this function.
   *
   * The token is scrubbed out of anything the Vercel write says back: the
   * gateway scrubs the *connection's* stored credentials from a failure, and
   * this token is neither of those — it belongs to the database, not to the
   * account. A 4xx that quotes the request back is the ordinary case.
   */
  const attachToVercel = Effect.fn("upstash.attach_rest_credentials_to_vercel")(function* (
    call: ConnectionVendorCall,
  ) {
    const secondary = call.secondary;
    if (secondary === undefined || secondary.vendorId !== "vercel") {
      return yield* Effect.fail(
        vendorFailure(
          call.operationId,
          "This operation moves a secret into a Vercel project and no Vercel connection was resolved for it. Nothing was fetched and nothing was written.",
        ),
      );
    }
    const vercelToken = secondary.credentials["accessToken"];
    if (vercelToken === undefined) {
      return yield* Effect.fail(
        vendorFailure(call.operationId, "The Vercel connection has no access token stored."),
      );
    }
    const credential = yield* basic(call);
    const databaseId = asString(call.arguments["databaseId"]);
    const database = yield* readDatabase({
      operationId: call.operationId,
      credential,
      databaseId,
      withCredentials: true,
    });
    yield* requireName(call.operationId, database, asString(call.arguments["database"]));
    const restToken = asString(database["rest_token"]);
    const endpoint = asString(database["endpoint"]);
    if (restToken.length === 0 || endpoint.length === 0) {
      return yield* Effect.fail(
        vendorFailure(
          call.operationId,
          "Upstash returned no REST endpoint and token for that database, so nothing was written to Vercel.",
        ),
      );
    }
    const vercelProject = asString(call.arguments["vercelProject"]);
    const target = asString(call.arguments["target"]);
    const keys = yield* setVercelEnvironmentVariables({
      http,
      operationId: call.operationId,
      bearer: vercelToken,
      account: secondary.account,
      project: vercelProject,
      target,
      variables: [
        {
          key: asString(call.arguments["urlVariableName"]),
          value: Redacted.make(restUrl(endpoint)),
        },
        { key: asString(call.arguments["tokenVariableName"]), value: Redacted.make(restToken) },
      ],
    }).pipe(
      Effect.mapError((error): ConnectionVendorError => {
        const detail = scrubCredentialValues(error.detail, [restToken]);
        // This half ran on the Vercel connection, so a refused token is
        // Vercel's to reconnect, not this vendor's.
        return new ConnectionVendorError({
          operationId: call.operationId,
          detail,
          ...(error.status === undefined ? {} : { status: error.status }),
          ...(error.unauthorized === true
            ? { unauthorized: true, rejectedCredential: "secondary" as const }
            : {}),
        });
      }),
    );
    return { vercelProject, target, keys };
  });

  const deleteDatabase = Effect.fn("upstash.delete_database")(function* (
    call: ConnectionVendorCall,
  ) {
    const credential = yield* basic(call);
    const databaseId = asString(call.arguments["databaseId"]);
    // Confirming a name does not need the database's credentials, so it is
    // read without them.
    const database = yield* readDatabase({
      operationId: call.operationId,
      credential,
      databaseId,
      withCredentials: false,
    });
    const name = yield* requireName(
      call.operationId,
      database,
      asString(call.arguments["database"]),
    );
    yield* send({
      operationId: call.operationId,
      method: "DELETE",
      url: `${API}/redis/database/${segment(databaseId)}`,
      basic: credential,
    });
    return { database: name, deleted: true };
  });

  const execute = Effect.fn("upstash.execute")(function* (call: ConnectionVendorCall) {
    switch (call.operationId) {
      case "upstash.list_databases": {
        const credential = yield* basic(call);
        const body = yield* send({
          operationId: call.operationId,
          method: "GET",
          url: `${API}/redis/databases`,
          basic: credential,
        });
        const rows = Array.isArray(body) ? body : [];
        // Upstash answers a list with credentials on every row; only three
        // safe fields are read out of each.
        return {
          databases: rows.map((row) => {
            const database = asRecord(row);
            return {
              database: asString(database["database_name"]),
              databaseId: asString(database["database_id"]),
              primaryRegion: asString(database["primary_region"]),
            };
          }),
        };
      }
      case "upstash.create_redis_database": {
        const credential = yield* basic(call);
        const plan = asString(call.arguments["plan"]);
        const created = asRecord(
          yield* send({
            operationId: call.operationId,
            method: "POST",
            url: `${API}/redis/database`,
            basic: credential,
            body: {
              database_name: asString(call.arguments["name"]),
              platform: PLATFORM,
              primary_region: asString(call.arguments["primaryRegion"]),
              plan,
              tls: true,
            },
          }),
        );
        // The reply carries the new database's REST token and Redis password.
        // Neither is read here: the way they reach an application is the
        // transfer, server-side.
        return {
          database: asString(created["database_name"]),
          databaseId: asString(created["database_id"]),
          primaryRegion: asString(created["primary_region"]),
          plan,
        };
      }
      case "upstash.delete_database":
        return yield* deleteDatabase(call);
      case "upstash.attach_rest_credentials_to_vercel":
        return yield* attachToVercel(call);
      default:
        return yield* Effect.fail(
          vendorFailure(call.operationId, "The Upstash adapter does not implement this operation."),
        );
    }
  });

  const validate: ConnectionVendorAdapter["validate"] = (credentials) =>
    Effect.gen(function* () {
      const credential = yield* basic({ operationId: "upstash.validate", credentials });
      // Upstash has no "who am I" endpoint, so the listing an account can
      // always do is what proves the pair works.
      const response = yield* http({
        operationId: "upstash.validate",
        method: "GET",
        url: `${API}/redis/databases`,
        basic: credential,
      });
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          vendorFailure(
            "upstash.validate",
            `HTTP ${response.status}: ${JSON.stringify(response.body)}`,
            isUnauthorizedStatus(response.status),
          ),
        );
      }
      const email = Redacted.value(credential.username);
      return {
        account: {
          // The only identity Upstash's management API states is the email the
          // owner typed, which they already know.
          accountId: email,
          accountName: email,
          teamId: null,
          teamName: null,
        },
        // An Upstash API key may be read-only, and nothing in a reply says
        // which. `null` is "we cannot tell", and a write the key cannot do
        // fails against Upstash, whose refusal names it better than a guess.
        grantedScopes: null,
        verifiedCapabilities: IMPLEMENTED,
      };
    });

  return {
    vendorId: "upstash",
    vendorSchema: (operationId) => {
      const schema = VENDOR_SCHEMAS[operationId];
      return schema === undefined
        ? Effect.fail(
            vendorFailure(
              operationId,
              `The Upstash adapter does not speak for ${operationId}, so this build cannot run it. Nothing ran.`,
            ),
          )
        : Effect.succeed(schema);
    },
    execute,
    validate,
  };
};
