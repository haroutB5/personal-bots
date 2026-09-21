import type { CreateAppDataStorePlan, CreateAppDeploymentTarget } from "@t3tools/contracts";

/**
 * The stores a `create_app` run can provision, as the bot asks for them.
 *
 * Deliberately two words rather than a vendor name and a region: the bot is
 * choosing a shape of storage for the owner's app, not an account or a
 * billing decision. Which vendor, which region and what it may cost are this
 * file's business, and they land in the plan the owner reads.
 */
export type CreateAppDataStoreKind = "postgres" | "redis";

/**
 * London, because the owner is in the UK and the free tiers are the same
 * everywhere. Both values are in the operations' reviewed region allowlists;
 * a region nobody reviewed is not provisioned into.
 */
const NEON_REGION = "aws-eu-west-2";
const UPSTASH_REGION = "eu-west-1";

/**
 * Free tiers only. A run that can silently start costing money is not a run
 * the owner approved by reading one card, and `costCeiling` is the sentence
 * they actually read.
 */
const NEON_TIER = "free";
const UPSTASH_TIER = "free";

const vercelEnvResources = (
  project: string,
  targets: ReadonlyArray<CreateAppDeploymentTarget>,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  `vercel:project:${project}`,
  ...targets.flatMap((target) => [
    `vercel:target:${target}`,
    ...keys.map((key) => `vercel:env:${target}:${key}`),
  ]),
];

/**
 * One store's plan, including every resource its step will touch.
 *
 * `targetResources` has to enumerate the Vercel environment keys as well as
 * the store itself, because the step moves the credential into Vercel and
 * `planCovers` authorizes a step only for resources the plan named. Getting
 * this wrong fails closed: the gateway refuses the transfer mid-run.
 */
export function createAppDataStorePlan(input: {
  readonly kind: CreateAppDataStoreKind;
  readonly appName: string;
  readonly vercelProject: string;
  readonly environmentTargets: ReadonlyArray<CreateAppDeploymentTarget>;
}): CreateAppDataStorePlan {
  const { appName, vercelProject, environmentTargets } = input;
  if (input.kind === "postgres") {
    const keys = ["DATABASE_URL"];
    return {
      stepId: "neon.store",
      vendorId: "neon",
      title: "Create the Postgres database and give the app its connection string",
      resourceName: appName,
      region: NEON_REGION,
      tier: NEON_TIER,
      costCeiling: "Neon free tier only; no paid usage is enabled by this run.",
      operationIds: [
        "neon.create_project",
        "neon.list_projects",
        "neon.attach_connection_string_to_vercel",
      ],
      targetResources: [
        `neon:project:${appName}`,
        `neon:database:neondb`,
        ...vercelEnvResources(vercelProject, environmentTargets, keys),
      ],
      environmentKeys: keys,
    };
  }

  const keys = ["KV_REST_API_URL", "KV_REST_API_TOKEN"];
  return {
    stepId: "upstash.store",
    vendorId: "upstash",
    title: "Create the Redis database and give the app its credentials",
    resourceName: appName,
    region: UPSTASH_REGION,
    tier: UPSTASH_TIER,
    costCeiling: "Upstash free plan only; the pay-as-you-go plan is not used by this run.",
    operationIds: [
      "upstash.create_redis_database",
      "upstash.list_databases",
      "upstash.attach_rest_credentials_to_vercel",
    ],
    targetResources: [
      `upstash:database:${appName}`,
      ...vercelEnvResources(vercelProject, environmentTargets, keys),
    ],
    environmentKeys: keys,
  };
}

/** The database Neon creates with a new project, which is what the app connects to. */
export const NEON_DEFAULT_DATABASE = "neondb";
