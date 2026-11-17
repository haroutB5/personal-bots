// Judges one replay case against the release planner: does the plan run every test
// a change must run? Used by planner-replay.test.mjs. Reads the tree it is given.
import { SERVER_ALWAYS, SERVER_GATE_DIRS } from "../lib/serverTestSelect.mjs";
import { planChecks } from "../lib/gateScope.mjs";

const KOTLIN_TEST = /^apps\/hbots-mobile\/modules\/[^/]+\/android\/src\/test\/.+\.kt$/;

// The check that can run a test file at all, read off the gate commands and the
// vitest configs. Written apart from the planner's own GATE_TEST_RULES.
export function owningCheck(file, releaseToolTests) {
  if (file.startsWith("apps/server/")) {
    const rel = file.slice("apps/server/".length);
    return SERVER_GATE_DIRS.some((dir) => rel.startsWith(`${dir}/`)) && /\.test\.tsx?$/.test(rel)
      ? "server-tests"
      : null;
  }
  if (file.startsWith("apps/web/")) {
    if (/\.browser\.test\./.test(file) || !/\.test\.tsx?$/.test(file)) return null;
    return file.startsWith("apps/web/src/features/personal/") ||
      file === "apps/web/src/authBootstrap.test.ts" ||
      file === "apps/web/src/components/chat/providerIconUtils.test.ts"
      ? "web-tests"
      : null;
  }
  if (KOTLIN_TEST.test(file)) return "hbots-mobile-kotlin";
  if (/^apps\/hbots-mobile\/(?:src|scripts)\/.+\.test\.ts$/.test(file)) return "hbots-mobile";
  if (file.startsWith("packages/personal-client/") && /\.test\.tsx?$/.test(file))
    return "personal-client";
  return releaseToolTests.has(file) ? "release-tools" : null;
}

function covered(test, plan) {
  if (!plan) return false;
  if (plan.mode === "skip") return false;
  if (plan.mode === "whole") return true;
  if (plan.id === "server-tests") {
    const relative = test.slice("apps/server/".length);
    return plan.args.includes(relative) || SERVER_ALWAYS.includes(relative);
  }
  if (plan.id === "hbots-mobile-kotlin")
    return plan.args.includes(`:${/modules\/([^/]+)\//.exec(test)[1]}:testDebugUnitTest`);
  return plan.args.includes(test);
}

/** A reader that remembers what it read, so many plans over one tree walk it once. */
export function cachedReader(reader) {
  const memo = (fn) => {
    const seen = new Map();
    return (key) => {
      if (!seen.has(key)) seen.set(key, fn(key));
      return seen.get(key);
    };
  };
  return {
    ...reader,
    listFiles: memo(reader.listFiles),
    exists: memo(reader.exists),
    read: memo(reader.read),
  };
}

const releaseToolTests = new WeakMap();
const releaseToolsOf = (reader) => {
  if (!releaseToolTests.has(reader))
    releaseToolTests.set(
      reader,
      new Set(
        planChecks(["package.json"], { reader }).plans.find((plan) => plan.id === "release-tools")
          .args,
      ),
    );
  return releaseToolTests.get(reader);
};

/**
 * `{ hit, missed, shape }`. A case is a hit when the plan ran every `mustRun`
 * test that exists in the tree. An unmapped path stops the plan, which is a miss.
 * `shape` is the plan as check id to mode, or `{ stopped }` for unmapped paths.
 */
export function replay({ changedPaths, mustRun = [] }, reader) {
  const scope = planChecks(changedPaths, { reader });
  const exist = mustRun.filter((test) => reader.exists(test));
  if (scope.error) return { hit: false, missed: exist, shape: { stopped: scope.paths } };
  const releaseTools = releaseToolsOf(reader);
  const byId = new Map(scope.plans.map((plan) => [plan.id, plan]));
  const missed = exist.filter((test) => {
    const check = owningCheck(test, releaseTools);
    return !covered(test, check ? byId.get(check) : undefined);
  });
  return {
    hit: missed.length === 0,
    missed,
    shape: Object.fromEntries(
      scope.plans.filter((plan) => plan.mode !== "skip").map((plan) => [plan.id, plan.mode]),
    ),
  };
}
