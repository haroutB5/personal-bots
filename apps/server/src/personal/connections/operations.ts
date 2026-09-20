import * as NodeCrypto from "node:crypto";

import type { ConnectionId, PersonalConnectionVendorId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";

/**
 * What a bot may ask a connection to do, and how dangerous each request is.
 *
 * Risk is a property of the operation *and* its validated arguments, never of
 * the tool name: the same `create_repository` is a private scratch repo or a
 * publication depending on one field. Everything here is pure so the gateway's
 * decision can be tested without a vendor, a database or a bot.
 */

export type ConnectionRiskReason =
  | "read_only"
  /** Changes the owner's account state at the vendor. */
  | "account_write"
  /** Makes something of the owner's visible to the world. */
  | "publication"
  /** Ships code or configuration to a running site. A repository write counts. */
  | "deployment"
  /**
   * A statement or command we deliberately do not read. Generic SQL and
   * generic Redis are gated as a class: deciding by text would mean writing a
   * parser a crafted statement can walk past.
   */
  | "unbounded_statement";

export interface ConnectionRisk {
  readonly approvalRequired: boolean;
  readonly reason: ConnectionRiskReason;
  /**
   * The sentence the owner reads on the approval card, written here on the
   * server from the validated arguments. The model never contributes a word
   * of it: a prompt-injected bot would otherwise describe its own action.
   */
  readonly summary: string;
}

export class ConnectionOperationArgumentError extends Schema.TaggedError<ConnectionOperationArgumentError>()(
  "ConnectionOperationArgumentError",
  { operationId: Schema.String, message: Schema.String },
) {}

/** A call that passed validation: everything an approval binds to but the connection. */
export interface PreparedConnectionOperation {
  readonly operationId: string;
  readonly vendorId: PersonalConnectionVendorId;
  /** Re-encoded from the schema, so only reviewed fields survive. */
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly risk: ConnectionRisk;
  readonly targetResources: ReadonlyArray<string>;
}

export interface ConnectionOperation {
  readonly operationId: string;
  readonly vendorId: PersonalConnectionVendorId;
  /** Model-facing, read beside the argument schema. */
  readonly description: string;
  /** JSON Schema text for the model; generated once from the same schema that validates. */
  readonly argumentsJsonSchema: string;
  /** The only result fields that may reach the model. */
  readonly resultFields: ReadonlyArray<string>;
  /**
   * The vendor request/response shape this operation was reviewed against.
   * An adapter reporting anything else is a drifted vendor, and the gateway
   * stops instead of executing against a shape nobody has looked at.
   */
  readonly reviewedVendorSchema: string;
  readonly prepare: (
    raw: unknown,
  ) => Effect.Effect<PreparedConnectionOperation, ConnectionOperationArgumentError>;
}

const defineOperation = <const Fields extends Schema.Struct.Fields>(input: {
  readonly operationId: string;
  readonly vendorId: PersonalConnectionVendorId;
  readonly description: string;
  readonly fields: Fields;
  readonly resultFields: ReadonlyArray<string>;
  readonly reviewedVendorSchema: string;
  readonly classify: (args: Schema.Struct<Fields>["Type"]) => ConnectionRisk;
  readonly targetResources: (args: Schema.Struct<Fields>["Type"]) => ReadonlyArray<string>;
}): ConnectionOperation => {
  const struct = Schema.Struct(input.fields);
  // Every field in this catalog is a plain, service-free schema. Saying so
  // here keeps validation out of the Effect context: an operation whose
  // arguments could only be decoded with a service would be a gateway that
  // needs the world to tell a good call from a bad one.
  const schema = struct as unknown as Schema.Codec<
    Schema.Struct<Fields>["Type"],
    Schema.Struct<Fields>["Encoded"]
  >;
  const decode = Schema.decodeUnknownEffect(schema);
  const encode = Schema.encodeSync(schema);
  const allowedKeys = new Set(Object.keys(input.fields));

  return {
    operationId: input.operationId,
    vendorId: input.vendorId,
    description: input.description,
    argumentsJsonSchema: JSON.stringify(Tool.getJsonSchemaFromSchema(struct)),
    resultFields: input.resultFields,
    reviewedVendorSchema: input.reviewedVendorSchema,
    prepare: (raw) =>
      Effect.gen(function* () {
        const fail = (message: string) =>
          new ConnectionOperationArgumentError({ operationId: input.operationId, message });
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          return yield* fail("Arguments must be an object.");
        }
        // Excess properties are a different action from the one that was
        // reviewed, so they stop the call rather than being dropped quietly:
        // a field we ignore here is a field the vendor might not.
        const unexpected = Object.keys(raw).filter((key) => !allowedKeys.has(key));
        if (unexpected.length > 0) {
          return yield* fail(
            `Unknown argument${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}. Allowed: ${[...allowedKeys].join(", ")}.`,
          );
        }
        const args = yield* decode(raw).pipe(
          Effect.mapError(() =>
            fail(`Arguments do not match the schema for ${input.operationId}.`),
          ),
        );
        return {
          operationId: input.operationId,
          vendorId: input.vendorId,
          arguments: encode(args) as Readonly<Record<string, unknown>>,
          risk: input.classify(args),
          targetResources: input.targetResources(args),
        };
      }),
  };
};

const SlugText = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._\-\/]{1,100}$/));
const FreeText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000));
/** A file may legitimately be empty, so this one has no lower bound. */
const FileText = Schema.String.check(Schema.isMaxLength(200_000));

const GithubListRepositories = defineOperation({
  operationId: "github.list_repositories",
  vendorId: "github",
  description: "List the repositories the connected GitHub account can reach.",
  fields: {},
  resultFields: ["repositories"],
  reviewedVendorSchema: "github/repos@2026-09-20",
  classify: () => ({
    approvalRequired: false,
    reason: "read_only",
    summary: "Read the list of GitHub repositories.",
  }),
  targetResources: () => [],
});

const GithubCreateRepository = defineOperation({
  operationId: "github.create_repository",
  vendorId: "github",
  description: "Create a repository on the connected GitHub account.",
  fields: { name: SlugText, visibility: Schema.Literals(["private", "public"]) },
  resultFields: ["repository", "htmlUrl"],
  reviewedVendorSchema: "github/repos@2026-09-20",
  classify: (args) =>
    args.visibility === "public"
      ? {
          approvalRequired: true,
          reason: "publication",
          summary: `Create the public GitHub repository ${args.name}. Anyone on the internet will be able to read it.`,
        }
      : {
          approvalRequired: true,
          reason: "account_write",
          summary: `Create the private GitHub repository ${args.name}.`,
        },
  targetResources: (args) => [`github:repository:${args.name}`],
});

const GithubPushFiles = defineOperation({
  operationId: "github.push_files",
  vendorId: "github",
  description: "Commit and push files to a branch of a connected repository.",
  fields: {
    repository: SlugText,
    branch: SlugText,
    files: Schema.Array(Schema.Struct({ path: SlugText, contents: FileText })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(50),
    ),
  },
  resultFields: ["repository", "branch", "commitSha"],
  reviewedVendorSchema: "github/contents@2026-09-20",
  // Whether a push ships is a property of the repository's own hooks, which
  // nothing here can see, so every repository write is treated as a
  // deployment. Guessing the other way would ship a site on a bot's word.
  classify: (args) => ({
    approvalRequired: true,
    reason: "deployment",
    summary: `Push ${args.files.length} file${args.files.length === 1 ? "" : "s"} to ${args.repository} on branch ${args.branch}. If the repository is connected to a host, this deploys.`,
  }),
  targetResources: (args) => [
    `github:repository:${args.repository}`,
    `github:branch:${args.branch}`,
  ],
});

const VercelListProjects = defineOperation({
  operationId: "vercel.list_projects",
  vendorId: "vercel",
  description: "List the Vercel projects the connected account can reach.",
  fields: {},
  resultFields: ["projects"],
  reviewedVendorSchema: "vercel/v9-projects@2026-09-20",
  classify: () => ({
    approvalRequired: false,
    reason: "read_only",
    summary: "Read the list of Vercel projects.",
  }),
  targetResources: () => [],
});

const VercelCreateDeployment = defineOperation({
  operationId: "vercel.create_deployment",
  vendorId: "vercel",
  description: "Deploy a Vercel project to preview or production.",
  fields: { project: SlugText, target: Schema.Literals(["preview", "production"]) },
  resultFields: ["deploymentId", "url", "target"],
  reviewedVendorSchema: "vercel/v13-deployments@2026-09-20",
  classify: (args) => ({
    approvalRequired: true,
    reason: "deployment",
    summary: `Deploy the Vercel project ${args.project} to ${args.target}.`,
  }),
  targetResources: (args) => [`vercel:project:${args.project}`, `vercel:target:${args.target}`],
});

const NeonListProjects = defineOperation({
  operationId: "neon.list_projects",
  vendorId: "neon",
  description: "List the Neon projects the connected account can reach.",
  fields: {},
  resultFields: ["projects"],
  reviewedVendorSchema: "neon/v2-projects@2026-09-20",
  classify: () => ({
    approvalRequired: false,
    reason: "read_only",
    summary: "Read the list of Neon projects.",
  }),
  targetResources: () => [],
});

const NeonRunSql = defineOperation({
  operationId: "neon.run_sql",
  vendorId: "neon",
  description:
    "Run one SQL statement against a Neon database. Always needs the user's approval, whatever the statement is.",
  fields: { project: SlugText, database: SlugText, statement: FreeText },
  resultFields: ["rows", "rowCount"],
  reviewedVendorSchema: "neon/v2-sql@2026-09-20",
  // Gated as a class. The statement reaches the owner verbatim so they can
  // read it, but it is never parsed to decide: a classifier that lets
  // "SELECT" through is one crafted statement away from dropping a table.
  classify: (args) => ({
    approvalRequired: true,
    reason: "unbounded_statement",
    summary: `Run SQL on the Neon database ${args.database} (project ${args.project}): ${args.statement}`,
  }),
  targetResources: (args) => [`neon:project:${args.project}`, `neon:database:${args.database}`],
});

const UpstashListDatabases = defineOperation({
  operationId: "upstash.list_databases",
  vendorId: "upstash",
  description: "List the Upstash databases the connected account can reach.",
  fields: {},
  resultFields: ["databases"],
  reviewedVendorSchema: "upstash/v2-databases@2026-09-20",
  classify: () => ({
    approvalRequired: false,
    reason: "read_only",
    summary: "Read the list of Upstash databases.",
  }),
  targetResources: () => [],
});

const UpstashRedisCommand = defineOperation({
  operationId: "upstash.redis_command",
  vendorId: "upstash",
  description:
    "Run one Redis command against an Upstash database. Always needs the user's approval, whatever the command is.",
  fields: {
    database: SlugText,
    command: Schema.Array(FreeText).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  },
  resultFields: ["result"],
  reviewedVendorSchema: "upstash/v2-redis@2026-09-20",
  // Same class rule as SQL: FLUSHALL and GET differ by one word.
  classify: (args) => ({
    approvalRequired: true,
    reason: "unbounded_statement",
    summary: `Run the Redis command ${args.command.join(" ")} on the Upstash database ${args.database}.`,
  }),
  targetResources: (args) => [`upstash:database:${args.database}`],
});

export const CONNECTION_OPERATIONS: ReadonlyArray<ConnectionOperation> = [
  GithubListRepositories,
  GithubCreateRepository,
  GithubPushFiles,
  VercelListProjects,
  VercelCreateDeployment,
  NeonListProjects,
  NeonRunSql,
  UpstashListDatabases,
  UpstashRedisCommand,
];

const BY_ID = new Map(CONNECTION_OPERATIONS.map((operation) => [operation.operationId, operation]));

/** No fuzzy matching: an operation we do not know by name does not run. */
export const findOperation = (operationId: string): Option.Option<ConnectionOperation> =>
  Option.fromNullishOr(BY_ID.get(operationId.trim()));

export const operationsForVendor = (vendorId: PersonalConnectionVendorId) =>
  CONNECTION_OPERATIONS.filter((operation) => operation.vendorId === vendorId);

/** Key order never changes an action's identity, so sort on the way in. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export interface NormalizedAction {
  readonly operationId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly connectionId: ConnectionId;
  /** Bound so a rotated credential invalidates an approval given for the old one. */
  readonly credentialVersion: number;
  readonly targetResources: ReadonlyArray<string>;
}

/** What an approval is for. Anything that changes the action changes this. */
export const normalizedActionDigest = (action: NormalizedAction): string =>
  NodeCrypto.createHash("sha256")
    .update(
      canonicalJson({
        operationId: action.operationId,
        arguments: action.arguments,
        connectionId: action.connectionId,
        credentialVersion: action.credentialVersion,
        targetResources: [...action.targetResources].toSorted(),
      }),
    )
    .digest("hex");

/** Drops every field the operation was not reviewed to return. */
export const allowlistResult = (
  operation: ConnectionOperation,
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    operation.resultFields
      .filter((field) => Object.hasOwn(result, field))
      .map((field) => [field, result[field]]),
  );

const REDACTED = "[redacted]";

/**
 * Every rendering of a credential we can produce ourselves, removed from a
 * value's text. Vendor errors quote the request back: raw in a header, URL-
 * encoded in a query string, base64 in a Basic auth header, backslash-escaped
 * inside a nested JSON body. Anything left is not text we generated.
 */
export const scrubCredentialValues = (
  value: unknown,
  secrets: ReadonlyArray<string>,
): string => {
  let text =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value, errorReplacer) ?? String(value);
          } catch {
            return String(value);
          }
        })();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    for (const rendering of [
      secret,
      encodeURIComponent(secret),
      encodeURI(secret),
      Buffer.from(secret, "utf8").toString("base64"),
      Buffer.from(secret, "utf8").toString("base64url"),
      JSON.stringify(secret).slice(1, -1),
    ]) {
      text = text.split(rendering).join(REDACTED);
    }
  }
  return text;
};

/** Errors stringify to `{}`, which would hide the very message being scrubbed. */
const errorReplacer = (_key: string, value: unknown) =>
  value instanceof Error
    ? { name: value.name, message: value.message, cause: value.cause }
    : value;
