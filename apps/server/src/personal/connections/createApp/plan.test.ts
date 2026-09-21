import { assert, describe, it } from "@effect/vitest";
import type { CreateAppPlan } from "@t3tools/contracts";

import { STATIC_APP_TEMPLATE } from "./template.ts";
import {
  buildCreateAppPlan,
  createAppPlanDigest,
  describePlan,
  planCovers,
  planDifferences,
} from "./plan.ts";

const built = () =>
  buildCreateAppPlan({
    appName: "my-app",
    template: STATIC_APP_TEMPLATE,
    githubAccount: "octocat",
    repositoryName: "my-app",
    visibility: "private",
    branch: "main",
    vercelAccount: "octocat",
    vercelTeamName: null,
    projectName: "my-app",
    deploymentTarget: "production",
    environmentTargets: ["production"],
    dataStores: [],
  });

const plan = (): CreateAppPlan => {
  const result = built();
  if (result._tag === "Failure") throw new Error(result.failure);
  return result.success;
};

describe("create_app plan", () => {
  it("resolves the repository to owner/name so nothing is guessed at push time", () => {
    assert.equal(plan().github.repository, "octocat/my-app");
    assert.equal(plan().github.repositoryName, "my-app");
  });

  it("refuses a name that is not a usable repository or project name", () => {
    for (const appName of ["", "my app", "../escape", "a".repeat(120)]) {
      const result = buildCreateAppPlan({ ...planInput(), appName });
      assert.equal(result._tag, "Failure", `expected ${appName} to be refused`);
    }
  });

  it("refuses an environment target the plan does not name", () => {
    const result = buildCreateAppPlan({ ...planInput(), environmentTargets: [] });
    assert.equal(result._tag, "Failure");
  });

  it("hashes to the same value whatever order equal arrays arrive in", () => {
    const first = buildCreateAppPlan({
      ...planInput(),
      environmentTargets: ["preview", "production"],
    });
    const second = buildCreateAppPlan({
      ...planInput(),
      environmentTargets: ["production", "preview"],
    });
    assert.equal(first._tag, "Success");
    assert.equal(second._tag, "Success");
    if (first._tag !== "Success" || second._tag !== "Success") return;
    assert.equal(createAppPlanDigest(first.success), createAppPlanDigest(second.success));
  });

  it("changes its hash when the deployment target changes", () => {
    const preview = buildCreateAppPlan({
      ...planInput(),
      deploymentTarget: "preview",
      environmentTargets: ["preview"],
    });
    assert.equal(preview._tag, "Success");
    if (preview._tag !== "Success") return;
    assert.notEqual(createAppPlanDigest(preview.success), createAppPlanDigest(plan()));
  });

  it("changes its hash when the template is edited", () => {
    const edited = buildCreateAppPlan({
      ...planInput(),
      template: { ...STATIC_APP_TEMPLATE, digest: `${STATIC_APP_TEMPLATE.digest}0` },
    });
    assert.equal(edited._tag, "Success");
    if (edited._tag !== "Success") return;
    assert.notEqual(createAppPlanDigest(edited.success), createAppPlanDigest(plan()));
  });

  describe("coverage", () => {
    it("covers every step the slice it was built for will run", () => {
      const current = plan();
      const covered = [
        { operationId: "github.create_repository", targetResources: ["github:repository:my-app"] },
        {
          operationId: "github.push_files",
          targetResources: ["github:repository:octocat/my-app", "github:branch:main"],
        },
        {
          operationId: "vercel.create_project",
          targetResources: ["vercel:project:my-app", "github:repository:octocat/my-app"],
        },
        {
          operationId: "vercel.set_environment_variables",
          targetResources: [
            "vercel:project:my-app",
            "vercel:target:production",
            "vercel:env:production:APP_ENVIRONMENT_LABEL",
          ],
        },
        {
          operationId: "vercel.create_deployment",
          targetResources: ["vercel:project:my-app", "vercel:target:production"],
        },
      ];
      for (const action of covered) {
        assert.equal(planCovers(current, action).covered, true, action.operationId);
      }
    });

    it("does not cover the other deployment target", () => {
      const outcome = planCovers(plan(), {
        operationId: "vercel.create_deployment",
        targetResources: ["vercel:project:my-app", "vercel:target:preview"],
      });
      assert.equal(outcome.covered, false);
      assert.ok(outcome.reason?.includes("vercel:target:preview"));
    });

    it("does not cover a resource the plan never named", () => {
      const outcome = planCovers(plan(), {
        operationId: "github.create_repository",
        targetResources: ["github:repository:someone-elses-repo"],
      });
      assert.equal(outcome.covered, false);
    });

    it("does not cover an environment key the plan never named", () => {
      const outcome = planCovers(plan(), {
        operationId: "vercel.set_environment_variables",
        targetResources: [
          "vercel:project:my-app",
          "vercel:target:production",
          "vercel:env:production:DATABASE_URL",
        ],
      });
      assert.equal(outcome.covered, false);
      assert.ok(outcome.reason?.includes("DATABASE_URL"));
    });

    it("does not cover an operation outside the plan, even on a planned resource", () => {
      // A plan is not a licence for the resources it names. Running SQL on a
      // planned database is still an operation the owner never approved.
      const outcome = planCovers(plan(), {
        operationId: "neon.run_sql",
        targetResources: [],
      });
      assert.equal(outcome.covered, false);
      assert.ok(outcome.reason?.includes("neon.run_sql"));
    });

    it("covers exactly what a data store declares, and nothing more", () => {
      const withStore = buildCreateAppPlan({
        ...planInput(),
        dataStores: [
          {
            stepId: "neon.database",
            vendorId: "neon",
            title: "Create the Neon database",
            resourceName: "my-app-db",
            region: "aws-eu-west-2",
            tier: "free",
            costCeiling: "free tier only",
            operationIds: ["neon.create_project"],
            targetResources: ["neon:project:my-app-db"],
            environmentKeys: ["DATABASE_URL"],
          },
        ],
      });
      assert.equal(withStore._tag, "Success");
      if (withStore._tag !== "Success") return;
      assert.equal(
        planCovers(withStore.success, {
          operationId: "neon.create_project",
          targetResources: ["neon:project:my-app-db"],
        }).covered,
        true,
      );
      assert.equal(
        planCovers(withStore.success, {
          operationId: "neon.run_sql",
          targetResources: ["neon:project:my-app-db"],
        }).covered,
        false,
      );
      // The store's key becomes a planned environment name, so wiring it in is
      // covered by the same decision that approved provisioning it.
      assert.equal(
        planCovers(withStore.success, {
          operationId: "vercel.set_environment_variables",
          targetResources: [
            "vercel:project:my-app",
            "vercel:target:production",
            "vercel:env:production:DATABASE_URL",
          ],
        }).covered,
        true,
      );
    });
  });

  describe("material change", () => {
    it("reports nothing when the plan has not moved", () => {
      assert.deepEqual(planDifferences(plan(), plan()), []);
    });

    it("names a changed target, an added resource and an added cost", () => {
      const changed = buildCreateAppPlan({
        ...planInput(),
        deploymentTarget: "preview",
        environmentTargets: ["preview"],
        dataStores: [
          {
            stepId: "neon.database",
            vendorId: "neon",
            title: "Create the Neon database",
            resourceName: "my-app-db",
            region: "aws-eu-west-2",
            tier: "paid",
            costCeiling: "up to 10 USD a month",
            operationIds: ["neon.create_project"],
            targetResources: ["neon:project:my-app-db"],
            environmentKeys: ["DATABASE_URL"],
          },
        ],
      });
      assert.equal(changed._tag, "Success");
      if (changed._tag !== "Success") return;
      const differences = planDifferences(plan(), changed.success);
      assert.ok(differences.some((line) => line.includes("deployment target")));
      assert.ok(differences.some((line) => line.includes("my-app-db")));
      assert.ok(differences.some((line) => line.includes("10 USD")));
    });
  });

  it("describes itself in the owner's words, naming every account, target and cost", () => {
    const text = describePlan(plan());
    for (const expected of [
      "octocat/my-app",
      "private",
      "my-app",
      "production",
      STATIC_APP_TEMPLATE.revision,
      "free",
    ]) {
      assert.ok(text.includes(expected), `${expected} missing from: ${text}`);
    }
  });
});

const planInput = () => ({
  appName: "my-app",
  template: STATIC_APP_TEMPLATE,
  githubAccount: "octocat",
  repositoryName: "my-app",
  visibility: "private" as const,
  branch: "main",
  vercelAccount: "octocat",
  vercelTeamName: null,
  projectName: "my-app",
  deploymentTarget: "production" as const,
  environmentTargets: ["production" as const],
  dataStores: [],
});
