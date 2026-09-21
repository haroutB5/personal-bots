// @effect-diagnostics preferSchemaOverJson:off - quoting a vendor's own error body back, not decoding a known shape.
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type {
  ConnectionVendorAdapter,
  ConnectionVendorCall,
  ConnectionVendorError,
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
 * Neon over its management REST API.
 *
 * The management API rather than Neon's own MCP server: its maintainers
 * recommend that server for development and IDE work, it exposes a far wider
 * surface than the five things this build provisions, and its tool names and
 * arguments would sit outside the reviewed-operation gate that decides what
 * needs the owner's approval. Narrow REST calls keep every decision here.
 *
 * `neon.run_sql` is deliberately absent from the table below. Running SQL
 * needs a Postgres connection, not this API, and the connection string is
 * precisely the value this milestone exists to keep out of a bot's reach. The
 * gateway refuses an operation this adapter does not speak for, by name,
 * before it asks the owner anything.
 *
 * The shapes are literals here rather than read back from the operation
 * catalog, so the gateway's drift check compares two independent statements;
 * `neon.test.ts` asserts they agree.
 */

const API = "https://console.neon.tech/api/v2";

const VENDOR_SCHEMAS: Readonly<Record<string, string>> = {
  "neon.list_projects": "neon/v2-projects@2026-09-20",
  "neon.create_project": "neon/v2-projects@2026-09-21",
  "neon.create_database": "neon/v2-branch-databases@2026-09-21",
  "neon.delete_project": "neon/v2-project-delete@2026-09-21",
  // Both halves, because drift at either end is drift. The Vercel half is
  // stated here independently of `vercel.ts`; the test compares them.
  "neon.attach_connection_string_to_vercel":
    "neon/v2-connection-uri@2026-09-21+vercel/v10-project-env@2026-09-20",
};

const IMPLEMENTED = Object.keys(VENDOR_SCHEMAS);

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";

/** Path segments come from `ResourceName`, which has no slash; encoding is belt and braces. */
const segment = (value: string) => encodeURIComponent(value);

export const makeNeonAdapter = (http: VendorHttp): ConnectionVendorAdapter => {
  const token = (call: Pick<ConnectionVendorCall, "credentials" | "operationId">) => {
    const value = call.credentials["apiKey"];
    return value === undefined
      ? Effect.fail(vendorFailure(call.operationId, "The Neon connection has no API key stored."))
      : Effect.succeed(value);
  };

  const send = (request: VendorHttpRequest) =>
    http(request).pipe(Effect.flatMap((response) => expectOk(request.operationId, response)));

  /**
   * Fetches the connection string and writes it into a Vercel environment
   * without it ever leaving this function.
   *
   * The secret is scrubbed out of anything the Vercel write says back: the
   * gateway scrubs the *connection's* stored credentials from a failure, and
   * this value is neither of those — it was minted seconds ago by the other
   * provider. A 4xx that quotes the request back is the ordinary case.
   */
  const attachToVercel = Effect.fn("neon.attach_connection_string_to_vercel")(function* (
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
    const bearer = yield* token(call);
    const project = asString(call.arguments["project"]);
    const branch = call.arguments["branch"];
    const database = asString(call.arguments["database"]);
    const role = asString(call.arguments["role"]);
    const pooled = call.arguments["pooled"] === true;
    const vercelProject = asString(call.arguments["vercelProject"]);
    const target = asString(call.arguments["target"]);
    const variableName = asString(call.arguments["variableName"]);

    const query = [
      `database_name=${encodeURIComponent(database)}`,
      `role_name=${encodeURIComponent(role)}`,
      `pooled=${pooled ? "true" : "false"}`,
      // Omitted rather than guessed: Neon then uses the project's default
      // branch, which is the one a project is created with.
      ...(typeof branch === "string" ? [`branch_id=${encodeURIComponent(branch)}`] : []),
    ].join("&");

    const uri = asString(
      asRecord(
        yield* send({
          operationId: call.operationId,
          method: "GET",
          url: `${API}/projects/${segment(project)}/connection_uri?${query}`,
          bearer,
        }),
      )["uri"],
    );
    if (uri.length === 0) {
      return yield* Effect.fail(
        vendorFailure(
          call.operationId,
          `Neon returned no connection string for ${database}, so nothing was written to Vercel.`,
        ),
      );
    }
    const keys = yield* setVercelEnvironmentVariables({
      http,
      operationId: call.operationId,
      bearer: vercelToken,
      account: secondary.account,
      project: vercelProject,
      target,
      variables: [{ key: variableName, value: Redacted.make(uri) }],
    }).pipe(
      Effect.mapError((error): ConnectionVendorError => {
        const detail = scrubCredentialValues(error.detail, [uri]);
        return vendorFailure(call.operationId, detail, error.unauthorized);
      }),
    );
    return { vercelProject, target, keys };
  });

  const deleteProject = Effect.fn("neon.delete_project")(function* (call: ConnectionVendorCall) {
    const bearer = yield* token(call);
    const project = asString(call.arguments["project"]);
    const name = asString(call.arguments["name"]);
    // The owner approved deleting a name. Proving the id is that project
    // before deleting it is what stops an approval being spent on another one.
    const found = asRecord(
      asRecord(
        yield* send({
          operationId: call.operationId,
          method: "GET",
          url: `${API}/projects/${segment(project)}`,
          bearer,
        }),
      )["project"],
    );
    const actual = asString(found["name"]);
    if (actual !== name) {
      return yield* Effect.fail(
        vendorFailure(
          call.operationId,
          `The Neon project ${project} is called ${actual}, not ${name}, so nothing was deleted. Check which project you meant.`,
        ),
      );
    }
    yield* send({
      operationId: call.operationId,
      method: "DELETE",
      url: `${API}/projects/${segment(project)}`,
      bearer,
    });
    return { project: name, deleted: true };
  });

  const execute = Effect.fn("neon.execute")(function* (call: ConnectionVendorCall) {
    switch (call.operationId) {
      case "neon.list_projects": {
        const bearer = yield* token(call);
        const body = asRecord(
          yield* send({
            operationId: call.operationId,
            method: "GET",
            url: `${API}/projects?limit=100`,
            bearer,
          }),
        );
        const rows = Array.isArray(body["projects"]) ? body["projects"] : [];
        return {
          projects: rows.map((row) => {
            const project = asRecord(row);
            return {
              project: asString(project["name"]),
              projectId: asString(project["id"]),
              regionId: asString(project["region_id"]),
            };
          }),
        };
      }
      case "neon.create_project": {
        const bearer = yield* token(call);
        const created = asRecord(
          yield* send({
            operationId: call.operationId,
            method: "POST",
            url: `${API}/projects`,
            bearer,
            body: {
              project: {
                name: asString(call.arguments["name"]),
                region_id: asString(call.arguments["regionId"]),
              },
            },
          }),
        );
        const project = asRecord(created["project"]);
        const branch = asRecord(created["branch"]);
        const databases = Array.isArray(created["databases"]) ? created["databases"] : [];
        const database = asRecord(databases[0]);
        // `created.connection_uris` holds a live password. It is read nowhere
        // in this function, and the operation's result allowlist would drop it
        // even if it were: the way it reaches an application is the transfer.
        return {
          project: asString(project["name"]),
          projectId: asString(project["id"]),
          branchId: asString(branch["id"]),
          database: asString(database["name"]),
          role: asString(database["owner_name"]),
        };
      }
      case "neon.create_database": {
        const bearer = yield* token(call);
        const project = asString(call.arguments["project"]);
        const branch = asString(call.arguments["branch"]);
        const created = asRecord(
          asRecord(
            yield* send({
              operationId: call.operationId,
              method: "POST",
              url: `${API}/projects/${segment(project)}/branches/${segment(branch)}/databases`,
              bearer,
              body: {
                database: {
                  name: asString(call.arguments["name"]),
                  owner_name: asString(call.arguments["ownerRole"]),
                },
              },
            }),
          )["database"],
        );
        return {
          project,
          branch,
          database: asString(created["name"]),
          owner: asString(created["owner_name"]),
        };
      }
      case "neon.delete_project":
        return yield* deleteProject(call);
      case "neon.attach_connection_string_to_vercel":
        return yield* attachToVercel(call);
      default:
        return yield* Effect.fail(
          vendorFailure(call.operationId, "The Neon adapter does not implement this operation."),
        );
    }
  });

  const validate: ConnectionVendorAdapter["validate"] = (credentials) =>
    Effect.gen(function* () {
      const bearer = yield* token({ operationId: "neon.validate", credentials });
      const response = yield* http({
        operationId: "neon.validate",
        method: "GET",
        url: `${API}/users/me`,
        bearer,
      });
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          vendorFailure(
            "neon.validate",
            `HTTP ${response.status}: ${JSON.stringify(response.body)}`,
            isUnauthorizedStatus(response.status),
          ),
        );
      }
      const user = asRecord(response.body);
      const email = asString(user["email"]);
      return {
        account: {
          accountId: asString(user["id"]),
          accountName: email.length > 0 ? email : asString(user["login"]),
          // Neon has organisations, but a key that can reach one reaches it by
          // being an organisation key; there is no scope to pick per call.
          teamId: null,
          teamName: null,
        },
        // Neon states no scope list for an API key. `null` is "we cannot
        // tell", which is not the same as "this token has none".
        grantedScopes: null,
        verifiedCapabilities: IMPLEMENTED,
      };
    });

  return {
    vendorId: "neon",
    vendorSchema: (operationId) => {
      const schema = VENDOR_SCHEMAS[operationId];
      return schema === undefined
        ? Effect.fail(
            vendorFailure(
              operationId,
              `The Neon adapter does not speak for ${operationId}, so this build cannot run it. Nothing ran.`,
            ),
          )
        : Effect.succeed(schema);
    },
    execute,
    validate,
  };
};
