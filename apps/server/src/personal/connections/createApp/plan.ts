import * as NodeCrypto from "node:crypto";

import type {
  CreateAppDataStorePlan,
  CreateAppDeploymentTarget,
  CreateAppPlan,
  CreateAppRepositoryVisibility,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

import type { AppTemplate } from "./template.ts";

/**
 * The plan is the unit of consent.
 *
 * Everything the owner is asked about happens once, here: which accounts, what
 * the resources will be called, whether the repository is public, which
 * environment gets variables, which target is deployed, what it may cost, and
 * which pinned scaffold it starts from. The run then executes inside the plan
 * without asking again.
 *
 * `planCovers` is what makes that safe. It is the whole authorization rule:
 * an action runs unattended only if the plan named its operation *and* every
 * resource it touches. Coverage is an intersection of two independent things,
 * because either alone is too weak — a plan that names a repository is not a
 * licence to run anything against it, and an operation the plan names is not a
 * licence to point it at someone else's account.
 */

export interface BuildCreateAppPlanInput {
  readonly appName: string;
  readonly template: AppTemplate;
  readonly githubAccount: string;
  readonly repositoryName: string;
  readonly visibility: CreateAppRepositoryVisibility;
  readonly branch: string;
  readonly vercelAccount: string;
  readonly vercelTeamName: string | null;
  readonly projectName: string;
  readonly deploymentTarget: CreateAppDeploymentTarget;
  readonly environmentTargets: ReadonlyArray<CreateAppDeploymentTarget>;
  readonly dataStores: ReadonlyArray<CreateAppDataStorePlan>;
}

/** What a repository, project or branch may be called at both providers. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Read-only operations the run makes to find out what already exists. They are
 * covered by every plan because reconciliation has to be possible before a
 * retry: the alternative is a blind retry, which is the duplicate factory this
 * whole milestone exists to avoid.
 */
export const RECONCILE_OPERATIONS: ReadonlyArray<string> = [
  "github.list_repositories",
  "vercel.list_projects",
  "vercel.list_deployments",
];

const ordered = <A extends string>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
  [...new Set(values)].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));

export const buildCreateAppPlan = (
  input: BuildCreateAppPlanInput,
): Result.Result<CreateAppPlan, string> => {
  for (const [label, value] of [
    ["app name", input.appName],
    ["repository name", input.repositoryName],
    ["project name", input.projectName],
    ["branch", input.branch],
  ] as const) {
    if (!NAME_PATTERN.test(value)) {
      return Result.fail(
        `The ${label} "${value}" is not usable: letters, digits, dot, dash and underscore only, up to 100 characters.`,
      );
    }
  }
  if (input.githubAccount.trim().length === 0 || input.vercelAccount.trim().length === 0) {
    return Result.fail("Both accounts have to be resolved before a plan can be approved.");
  }
  if (input.environmentTargets.length === 0) {
    // A plan with no named environment could not set a variable without
    // inferring one, and inferring a target is what this design refuses to do.
    return Result.fail(
      "A plan has to name at least one environment: preview, production, or both.",
    );
  }

  const environmentKeys = ordered([
    ...input.template.environment.map((entry) => entry.key),
    ...input.dataStores.flatMap((store) => store.environmentKeys),
  ]);

  return Result.succeed({
    appName: input.appName,
    template: { revision: input.template.revision, digest: input.template.digest },
    github: {
      account: input.githubAccount,
      repository: `${input.githubAccount}/${input.repositoryName}`,
      repositoryName: input.repositoryName,
      visibility: input.visibility,
      branch: input.branch,
    },
    vercel: {
      account: input.vercelAccount,
      teamName: input.vercelTeamName,
      project: input.projectName,
      framework: input.template.framework,
    },
    deployment: {
      target: input.deploymentTarget,
      environmentTargets: ordered(input.environmentTargets),
    },
    environmentKeys,
    dataStores: input.dataStores,
    costCeiling:
      input.dataStores.length === 0
        ? "free: nothing in this plan is billable"
        : input.dataStores.map((store) => `${store.resourceName}: ${store.costCeiling}`).join("; "),
    healthCheck: input.template.healthCheck,
  } satisfies CreateAppPlan);
};

/** Key order never changes a plan's identity, so sort on the way in. */
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

/**
 * What the approval binds to. Any change to any field is a different plan and
 * therefore a different decision; nothing in a plan is advisory.
 */
export const createAppPlanDigest = (plan: CreateAppPlan): string =>
  NodeCrypto.createHash("sha256").update(canonicalJson(plan)).digest("hex");

/** Every operation the plan authorizes, and nothing else runs unattended. */
export const planCoveredOperations = (plan: CreateAppPlan): ReadonlySet<string> =>
  new Set([
    ...RECONCILE_OPERATIONS,
    "github.create_repository",
    "github.push_files",
    "vercel.create_project",
    ...(plan.environmentKeys.length === 0 ? [] : ["vercel.set_environment_variables"]),
    "vercel.create_deployment",
    ...plan.dataStores.flatMap((store) => store.operationIds),
  ]);

/**
 * Every resource the plan named, in the gateway's own vocabulary. The
 * repository appears under both renderings because `create_repository` names a
 * repository by its bare name and everything afterwards names it `owner/name`.
 */
export const planResourceUniverse = (plan: CreateAppPlan): ReadonlySet<string> =>
  new Set([
    `github:repository:${plan.github.repositoryName}`,
    `github:repository:${plan.github.repository}`,
    `github:branch:${plan.github.branch}`,
    `vercel:project:${plan.vercel.project}`,
    `vercel:target:${plan.deployment.target}`,
    ...plan.deployment.environmentTargets.map((target) => `vercel:target:${target}`),
    ...plan.deployment.environmentTargets.flatMap((target) =>
      plan.environmentKeys.map((key) => `vercel:env:${target}:${key}`),
    ),
    ...plan.dataStores.flatMap((store) => store.targetResources),
  ]);

export interface PlanCoverage {
  readonly covered: boolean;
  /** Why not, in the owner's words. Null when it is covered. */
  readonly reason: string | null;
}

export const planCovers = (
  plan: CreateAppPlan,
  action: { readonly operationId: string; readonly targetResources: ReadonlyArray<string> },
): PlanCoverage => {
  if (!planCoveredOperations(plan).has(action.operationId)) {
    return {
      covered: false,
      reason: `The approved plan does not include ${action.operationId}.`,
    };
  }
  const universe = planResourceUniverse(plan);
  const outside = action.targetResources.filter((resource) => !universe.has(resource));
  if (outside.length > 0) {
    return {
      covered: false,
      reason: `The approved plan does not include ${outside.join(", ")}.`,
    };
  }
  return { covered: true, reason: null };
};

/**
 * What moved between two plans, in the owner's words.
 *
 * Only used to explain why a fresh decision is being asked for: the decision
 * itself is taken by the digest, so a difference this function forgets to
 * describe still forces re-approval rather than slipping through.
 */
export const planDifferences = (
  previous: CreateAppPlan,
  next: CreateAppPlan,
): ReadonlyArray<string> => {
  const differences: Array<string> = [];
  const compare = (label: string, left: string, right: string) => {
    if (left !== right) differences.push(`${label}: ${left} becomes ${right}`);
  };
  compare("app name", previous.appName, next.appName);
  compare("template revision", previous.template.revision, next.template.revision);
  compare("template contents", previous.template.digest, next.template.digest);
  compare("GitHub repository", previous.github.repository, next.github.repository);
  compare("repository visibility", previous.github.visibility, next.github.visibility);
  compare("branch", previous.github.branch, next.github.branch);
  compare("Vercel project", previous.vercel.project, next.vercel.project);
  compare("Vercel account", previous.vercel.account, next.vercel.account);
  compare("deployment target", previous.deployment.target, next.deployment.target);
  compare(
    "environments",
    previous.deployment.environmentTargets.join(", "),
    next.deployment.environmentTargets.join(", "),
  );
  compare(
    "environment variables",
    previous.environmentKeys.join(", "),
    next.environmentKeys.join(", "),
  );
  compare("cost", previous.costCeiling, next.costCeiling);

  const before = new Map(previous.dataStores.map((store) => [store.stepId, store]));
  const after = new Map(next.dataStores.map((store) => [store.stepId, store]));
  for (const [stepId, store] of after) {
    const existing = before.get(stepId);
    if (existing === undefined) {
      differences.push(
        `added resource: ${store.resourceName} on ${store.vendorId} (${store.tier}, ${store.costCeiling})`,
      );
      continue;
    }
    compare(`${store.resourceName} tier`, existing.tier, store.tier);
    compare(`${store.resourceName} region`, existing.region, store.region);
    compare(`${store.resourceName} cost`, existing.costCeiling, store.costCeiling);
  }
  for (const [stepId, store] of before) {
    if (!after.has(stepId)) differences.push(`removed resource: ${store.resourceName}`);
  }
  return differences;
};

/**
 * The card the owner reads. Written here from the plan, never from anything a
 * model supplied, and naming every part of the plan that has a consequence.
 */
export const describePlan = (plan: CreateAppPlan): string => {
  const lines = [
    `Create the app "${plan.appName}" and put it live.`,
    `Scaffold: the pinned template ${plan.template.revision}.`,
    `GitHub: create the ${plan.github.visibility} repository ${plan.github.repository} on branch ${plan.github.branch}${
      plan.github.visibility === "public" ? " — anyone on the internet will be able to read it" : ""
    }.`,
    `Vercel: create the project ${plan.vercel.project} on ${
      plan.vercel.teamName === null ? plan.vercel.account : plan.vercel.teamName
    }, linked to that repository.`,
    plan.environmentKeys.length === 0
      ? "Environment variables: none."
      : `Environment variables on ${plan.deployment.environmentTargets.join(" and ")}: ${plan.environmentKeys.join(", ")} (names only; values are not shown).`,
    ...plan.dataStores.map(
      (store) =>
        `${store.vendorId}: create ${store.resourceName} in ${store.region} on the ${store.tier} tier.`,
    ),
    `Deploy to ${plan.deployment.target} and check the URL answers.`,
    `Cost: ${plan.costCeiling}.`,
    "Approving this runs every step above without asking again. Anything else — a different target, another resource, another cost — comes back to you.",
  ];
  return lines.join("\n");
};
