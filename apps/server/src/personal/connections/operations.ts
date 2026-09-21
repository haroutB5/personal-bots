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
  /**
   * A second connection this operation also needs, resolved by the gateway
   * alongside the first.
   *
   * It exists for one thing: moving a credential a provisioning vendor minted
   * into the place it is used, server-side, without the value ever becoming an
   * argument, a result, or transcript text. `null` for everything else, and
   * then the gateway resolves nothing extra.
   */
  readonly secondaryVendorId: PersonalConnectionVendorId | null;
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
  readonly secondaryVendorId?: PersonalConnectionVendorId;
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
    secondaryVendorId: input.secondaryVendorId ?? null,
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

/**
 * One segment of a provider resource name or id.
 *
 * Separate from `SlugText` for two reasons: these are interpolated into a URL
 * path segment, so a slash would let one argument name a different resource
 * than the one approved; and Neon's own default role is `neondb_owner`, which
 * a pattern without an underscore would refuse on every default database.
 */
const ResourceName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,100}$/));

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
  // The Git Data API, not Contents: every file has to land in one commit, and
  // per-file Contents writes would be one commit each with no way back.
  reviewedVendorSchema: "github/git-data@2026-09-20",
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

/** An environment variable name, not a sentence and not a shell fragment. */
const EnvVarName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/));

/**
 * Preview and production are separate literals with no default anywhere in
 * this file. A missing target is a refused call: inferring the safer one is
 * still inferring, and the owner approves a target by reading its name.
 */
const DeploymentTarget = Schema.Literals(["preview", "production"]);

const VercelCreateProject = defineOperation({
  operationId: "vercel.create_project",
  vendorId: "vercel",
  description:
    "Create a Vercel project on the connected account, optionally linked to a GitHub repository.",
  fields: {
    name: SlugText,
    framework: Schema.NullOr(
      Schema.Literals(["nextjs", "vite", "remix", "astro", "sveltekit", "nuxtjs"]),
    ),
    /** owner/name of an existing repository, or null for an unlinked project. */
    githubRepository: Schema.NullOr(SlugText),
  },
  resultFields: ["project", "projectId", "framework"],
  reviewedVendorSchema: "vercel/v10-projects@2026-09-20",
  classify: (args) => ({
    approvalRequired: true,
    reason: "account_write",
    summary:
      args.githubRepository === null
        ? `Create the Vercel project ${args.name}.`
        : `Create the Vercel project ${args.name}, linked to the GitHub repository ${args.githubRepository}.`,
  }),
  targetResources: (args) =>
    args.githubRepository === null
      ? [`vercel:project:${args.name}`]
      : [`vercel:project:${args.name}`, `github:repository:${args.githubRepository}`],
});

const VercelSetEnvironmentVariables = defineOperation({
  operationId: "vercel.set_environment_variables",
  vendorId: "vercel",
  description:
    "Set encrypted environment variables on one Vercel environment. Preview and production are separate targets and must be named.",
  fields: {
    project: SlugText,
    target: DeploymentTarget,
    variables: Schema.Array(Schema.Struct({ key: EnvVarName, value: FreeText })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(50),
    ),
  },
  // The values are the point of the call and are never echoed: what the owner
  // approves and what the bot reads back are the names.
  resultFields: ["project", "target", "keys"],
  reviewedVendorSchema: "vercel/v10-project-env@2026-09-20",
  classify: (args) => ({
    approvalRequired: true,
    // Production configuration is what the live site runs with, so it reads as
    // a deployment; a preview environment is an account edit.
    reason: args.target === "production" ? "deployment" : "account_write",
    summary: `Set ${args.variables.map((variable) => variable.key).join(", ")} on the ${args.target} environment of the Vercel project ${args.project}. The values are not shown here.`,
  }),
  targetResources: (args) => [
    `vercel:project:${args.project}`,
    `vercel:target:${args.target}`,
    ...args.variables.map((variable) => `vercel:env:${args.target}:${variable.key}`),
  ],
});

const VercelCreateDeployment = defineOperation({
  operationId: "vercel.create_deployment",
  vendorId: "vercel",
  description:
    "Deploy a Vercel project from a git ref to preview or production. The target must be named.",
  fields: { project: SlugText, target: DeploymentTarget, gitRef: SlugText },
  resultFields: ["deploymentId", "url", "target"],
  reviewedVendorSchema: "vercel/v13-deployments@2026-09-20",
  classify: (args) => ({
    approvalRequired: true,
    reason: "deployment",
    summary: `Deploy ${args.gitRef} of the Vercel project ${args.project} to ${args.target}.`,
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

/**
 * The regions this build was reviewed against, as an allowlist.
 *
 * A free-text region would be passed straight into a provisioning call, and a
 * value nobody has looked at either fails at the vendor or, worse, quietly
 * creates the resource somewhere the owner did not choose. Adding one is a
 * deliberate edit.
 */
const NeonRegion = Schema.Literals([
  "aws-us-east-1",
  "aws-us-east-2",
  "aws-us-west-2",
  "aws-eu-central-1",
  "aws-eu-west-2",
  "aws-ap-southeast-1",
  "aws-ap-southeast-2",
  "azure-eastus2",
]);

const NeonCreateProject = defineOperation({
  operationId: "neon.create_project",
  vendorId: "neon",
  description:
    "Create a Neon Postgres project. The region must be named; it decides where the data lives.",
  fields: { name: ResourceName, regionId: NeonRegion },
  // Neon replies to this call with a connection URI for the role it just
  // created. It is a password, and it is not in this list: the way it reaches
  // an application is `neon.attach_connection_string_to_vercel`, server-side.
  resultFields: ["project", "projectId", "branchId", "database", "role"],
  reviewedVendorSchema: "neon/v2-projects@2026-09-21",
  classify: (args) => ({
    approvalRequired: true,
    reason: "account_write",
    summary: `Create the Neon Postgres project ${args.name} in ${args.regionId}.`,
  }),
  targetResources: (args) => [`neon:project:${args.name}`],
});

const NeonCreateDatabase = defineOperation({
  operationId: "neon.create_database",
  vendorId: "neon",
  description: "Create a database on a branch of an existing Neon project.",
  fields: {
    project: ResourceName,
    branch: ResourceName,
    name: ResourceName,
    ownerRole: ResourceName,
  },
  resultFields: ["project", "branch", "database", "owner"],
  reviewedVendorSchema: "neon/v2-branch-databases@2026-09-21",
  classify: (args) => ({
    approvalRequired: true,
    reason: "account_write",
    summary: `Create the database ${args.name} on branch ${args.branch} of the Neon project ${args.project}, owned by ${args.ownerRole}.`,
  }),
  targetResources: (args) => [`neon:project:${args.project}`, `neon:database:${args.name}`],
});

const NeonDeleteProject = defineOperation({
  operationId: "neon.delete_project",
  vendorId: "neon",
  description:
    "Delete a Neon project and everything in it. Always needs the user's approval, and cannot be undone.",
  // Both, because they answer different questions. The id is what gets
  // deleted; the name is what the owner recognises on the card. The adapter
  // reads the project first and refuses if the two are not the same project,
  // so an approval given for a name cannot be spent on another id.
  fields: { project: ResourceName, name: ResourceName },
  resultFields: ["project", "deleted"],
  reviewedVendorSchema: "neon/v2-project-delete@2026-09-21",
  classify: (args) => ({
    approvalRequired: true,
    // `account_write` is the enum's word for it. The sentence below is what
    // the owner actually reads, and it does not understate what happens.
    reason: "account_write",
    summary: `Delete the Neon project ${args.name} (${args.project}), with every branch and database in it. This cannot be undone.`,
  }),
  targetResources: (args) => [`neon:project:${args.project}`],
});

/**
 * The server-side credential transfer.
 *
 * A Neon connection string is a password. It is fetched from Neon and written
 * into a Vercel environment inside one gateway call, and the only thing that
 * comes back is which variable names were set: there is no argument a value
 * could be put into and no result field it could come out of, so it never
 * exists as transcript text, as a tool argument, or in an approval summary.
 *
 * The pinned shape names both vendors, because drift at either end is drift.
 */
const NeonAttachConnectionStringToVercel = defineOperation({
  operationId: "neon.attach_connection_string_to_vercel",
  vendorId: "neon",
  secondaryVendorId: "vercel",
  description:
    "Copy a Neon database's connection string straight into a Vercel project's environment. The value is fetched and written on the server; you never see it, and you must not ask for it.",
  fields: {
    project: ResourceName,
    /** null uses the project's default branch, which is what a new project has. */
    branch: Schema.NullOr(ResourceName),
    database: ResourceName,
    role: ResourceName,
    /** Pooled is what a serverless runtime wants; the owner sees which on the card. */
    pooled: Schema.Boolean,
    vercelProject: SlugText,
    target: DeploymentTarget,
    variableName: EnvVarName,
  },
  resultFields: ["vercelProject", "target", "keys"],
  reviewedVendorSchema: "neon/v2-connection-uri@2026-09-21+vercel/v10-project-env@2026-09-20",
  classify: (args) => ({
    approvalRequired: true,
    reason: args.target === "production" ? "deployment" : "account_write",
    summary: `Put the ${args.pooled ? "pooled" : "direct"} Neon connection string for ${args.database} (project ${args.project}, role ${args.role}) into ${args.variableName} on the ${args.target} environment of the Vercel project ${args.vercelProject}. The value moves between the two providers on the server and is never shown to the bot or written into this chat.`,
  }),
  targetResources: (args) => [
    `neon:project:${args.project}`,
    `neon:database:${args.database}`,
    `vercel:project:${args.vercelProject}`,
    `vercel:target:${args.target}`,
    `vercel:env:${args.target}:${args.variableName}`,
  ],
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

/** Same allowlist rule as Neon's: a region nobody reviewed is not provisioned into. */
const UpstashRegion = Schema.Literals([
  "us-east-1",
  "us-west-1",
  "us-west-2",
  "eu-west-1",
  "eu-central-1",
  "ap-northeast-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "sa-east-1",
]);

const UpstashCreateRedisDatabase = defineOperation({
  operationId: "upstash.create_redis_database",
  vendorId: "upstash",
  description:
    "Create an Upstash Redis database. The region and the plan must both be named; the plan is what it costs.",
  fields: {
    name: ResourceName,
    primaryRegion: UpstashRegion,
    plan: Schema.Literals(["free", "payg"]),
  },
  // No token, no endpoint password: what an application needs is moved by
  // `upstash.attach_rest_credentials_to_vercel`, server-side.
  resultFields: ["database", "databaseId", "primaryRegion", "plan"],
  reviewedVendorSchema: "upstash/v2-redis-database@2026-09-21",
  classify: (args) => ({
    approvalRequired: true,
    reason: "account_write",
    summary:
      args.plan === "free"
        ? `Create the Upstash Redis database ${args.name} in ${args.primaryRegion} on the free plan.`
        : `Create the Upstash Redis database ${args.name} in ${args.primaryRegion} on the pay-as-you-go plan, which is billed per request against your Upstash account.`,
  }),
  targetResources: (args) => [`upstash:database:${args.name}`],
});

const UpstashDeleteDatabase = defineOperation({
  operationId: "upstash.delete_database",
  vendorId: "upstash",
  description:
    "Delete an Upstash database and everything stored in it. Always needs the user's approval, and cannot be undone.",
  /** Id and name, for the reason `neon.delete_project` takes both. */
  fields: { databaseId: ResourceName, database: ResourceName },
  resultFields: ["database", "deleted"],
  reviewedVendorSchema: "upstash/v2-redis-database-delete@2026-09-21",
  classify: (args) => ({
    approvalRequired: true,
    reason: "account_write",
    summary: `Delete the Upstash database ${args.database} (${args.databaseId}) and everything stored in it. This cannot be undone.`,
  }),
  targetResources: (args) => [`upstash:database:${args.databaseId}`],
});

/** The Upstash half of the server-side transfer; see the Neon one above. */
const UpstashAttachRestCredentialsToVercel = defineOperation({
  operationId: "upstash.attach_rest_credentials_to_vercel",
  vendorId: "upstash",
  secondaryVendorId: "vercel",
  description:
    "Copy an Upstash database's REST URL and token straight into a Vercel project's environment. The token is fetched and written on the server; you never see it, and you must not ask for it.",
  fields: {
    databaseId: ResourceName,
    database: ResourceName,
    vercelProject: SlugText,
    target: DeploymentTarget,
    urlVariableName: EnvVarName,
    tokenVariableName: EnvVarName,
  },
  resultFields: ["vercelProject", "target", "keys"],
  reviewedVendorSchema: "upstash/v2-redis-database@2026-09-21+vercel/v10-project-env@2026-09-20",
  classify: (args) => ({
    approvalRequired: true,
    reason: args.target === "production" ? "deployment" : "account_write",
    summary: `Put the Upstash REST URL and token for ${args.database} (${args.databaseId}) into ${args.urlVariableName} and ${args.tokenVariableName} on the ${args.target} environment of the Vercel project ${args.vercelProject}. The token moves between the two providers on the server and is never shown to the bot or written into this chat.`,
  }),
  // Keyed on the name, not the id, exactly like `create_redis_database`. A
  // create_app plan is written before the database exists, so an id here would
  // be a resource no plan could ever name: the transfer would be refused
  // mid-run, after the database had been created. The id is still an argument
  // and still in the summary the owner reads.
  targetResources: (args) => [
    `upstash:database:${args.database}`,
    `vercel:project:${args.vercelProject}`,
    `vercel:target:${args.target}`,
    `vercel:env:${args.target}:${args.urlVariableName}`,
    `vercel:env:${args.target}:${args.tokenVariableName}`,
  ],
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
  VercelCreateProject,
  VercelSetEnvironmentVariables,
  VercelCreateDeployment,
  NeonListProjects,
  NeonCreateProject,
  NeonCreateDatabase,
  NeonDeleteProject,
  NeonAttachConnectionStringToVercel,
  NeonRunSql,
  UpstashListDatabases,
  UpstashCreateRedisDatabase,
  UpstashDeleteDatabase,
  UpstashAttachRestCredentialsToVercel,
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
export const scrubCredentialValues = (value: unknown, secrets: ReadonlyArray<string>): string => {
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
  value instanceof Error ? { name: value.name, message: value.message, cause: value.cause } : value;
