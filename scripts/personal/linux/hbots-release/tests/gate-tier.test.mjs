// Tiered gates (Faster releases step 2): which checks block a release and which run after it.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  ASYNC_CHECKS,
  BLOCKING_SERVER_DEPTH,
  BLOCKING_SERVER_MAX,
  TIER_SELECTOR_FAR,
  TIER_SELECTOR_NEAR,
  planChecks,
  plansForTier,
  releaseTrack,
  tierPlans,
  verifyPlans,
} from "../lib/gateScope.mjs";
import { SERVER_ALWAYS, fsReader } from "../lib/serverTestSelect.mjs";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const REPO = NodePath.resolve(ROOT, "../../../..");
const SCRATCH = NodePath.join(REPO, ".tmp");
NodeFS.mkdirSync(SCRATCH, { recursive: true });

const LIVE = "a".repeat(40);
const RELEASE = "b".repeat(40);

// A server tree with a chain core.ts <- mid.ts <- far.ts, a test beside each, and the
// always-run guards, so a core.ts change selects tests one and three hops away.
function tree() {
  const dir = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "gate-tier-"));
  const write = (rel, text) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, rel)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, rel), text);
  };
  const src = "apps/server/src/personal/tier";
  write(`${src}/core.ts`, "export const core = 1;\n");
  write(`${src}/mid.ts`, 'import { core } from "./core.ts";\nexport const mid = core;\n');
  write(`${src}/far.ts`, 'import { mid } from "./mid.ts";\nexport const far = mid;\n');
  write(`${src}/core.test.ts`, 'import { core } from "./core.ts";\ncore;\n');
  write(`${src}/far.test.ts`, 'import { far } from "./far.ts";\nfar;\n');
  write(`${src}/other.test.ts`, "export {};\n");
  for (const guard of SERVER_ALWAYS) write(`apps/server/${guard}`, "export {};\n");
  write("apps/server/src/persistence/Migrations.ts", "export const migrations = [];\n");
  return { dir, reader: fsReader(dir) };
}

const withTree = (body) => {
  const t = tree();
  try {
    body(t);
  } finally {
    NodeFS.rmSync(t.dir, { recursive: true, force: true });
  }
};

const evidenceFor = (plans, { tier, changedPaths }) => ({
  ok: true,
  ...(tier ? { tier } : {}),
  gates: plans.map((plan) => ({
    id: plan.id,
    mode: plan.mode,
    ...(plan.deferredMode ? { deferredMode: plan.deferredMode } : {}),
    ...(plan.selector ? { selector: plan.selector } : {}),
    ...(plan.args ? { args: plan.args } : {}),
    ...(plan.id === "e2e" && plan.args ? { journeys: plan.args.map((id) => ({ id })) } : {}),
    baseSha: LIVE,
    changedPaths,
    reason: plan.reason,
  })),
});

const verify = (reader, changedPaths, evidence) =>
  verifyPlans({ evidence, liveSha: LIVE, releaseSha: RELEASE, changedPaths, reader });

NodeTest.test("a server change blocks on the near tests and runs the far ones after", () => {
  withTree(({ reader }) => {
    const changedPaths = ["apps/server/src/personal/tier/core.ts"];
    const scope = planChecks(changedPaths, { reader });
    const split = tierPlans(scope, { reader });
    NodeAssert.equal(split.tiered, true, split.reason);
    const near = split.blocking.find((plan) => plan.id === "server-tests");
    const far = split.async.find((plan) => plan.id === "server-tests");
    NodeAssert.equal(near.selector, TIER_SELECTOR_NEAR);
    NodeAssert.equal(far.selector, TIER_SELECTOR_FAR);
    NodeAssert.ok(near.args.includes("src/personal/tier/core.test.ts"), near.args.join(" "));
    NodeAssert.ok(far.args.includes("src/personal/tier/far.test.ts"), far.args.join(" "));
    NodeAssert.ok(!near.args.includes("src/personal/tier/far.test.ts"));
    // The two halves are exactly the whole selected plan, with nothing lost or doubled.
    const whole = scope.plans.find((plan) => plan.id === "server-tests");
    NodeAssert.deepEqual([...near.args, ...far.args].sort(), [...whole.args].sort());
    NodeAssert.equal(BLOCKING_SERVER_DEPTH, 1);
  });
});

NodeTest.test("a wide change blocks only on the tests that import a changed file directly", () => {
  withTree(({ dir, reader }) => {
    const src = "apps/server/src/personal/tier";
    // More than BLOCKING_SERVER_MAX tests one hop away, through mid.ts.
    for (let i = 0; i <= BLOCKING_SERVER_MAX; i += 1)
      NodeFS.writeFileSync(
        NodePath.join(dir, `${src}/wide${i}.test.ts`),
        'import { mid } from "./mid.ts";\nmid;\n',
      );
    const changedPaths = [`${src}/core.ts`];
    const scope = planChecks(changedPaths, { reader });
    const split = tierPlans(scope, { reader });
    const near = split.blocking.find((plan) => plan.id === "server-tests");
    const far = split.async.find((plan) => plan.id === "server-tests");
    NodeAssert.deepEqual(near.args, ["src/personal/tier/core.test.ts"]);
    NodeAssert.match(near.reason, /import a changed file directly/);
    NodeAssert.ok(far.args.includes("src/personal/tier/wide0.test.ts"));
    const whole = scope.plans.find((plan) => plan.id === "server-tests");
    NodeAssert.deepEqual([...near.args, ...far.args].sort(), [...whole.args].sort());
    // The seal recomputes the same split.
    NodeAssert.deepEqual(
      verify(reader, changedPaths, evidenceFor(split.blocking, { tier: "blocking", changedPaths })),
      [],
    );
  });
});

NodeTest.test("e2e, parity and kotlin are deferred in the blocking tier and run in async", () => {
  withTree(({ reader }) => {
    const changedPaths = ["apps/server/src/personal/tier/core.ts"];
    const scope = planChecks(changedPaths, { reader });
    const split = tierPlans(scope, { reader });
    for (const plan of scope.plans.filter((p) => ASYNC_CHECKS.includes(p.id))) {
      const blocking = split.blocking.find((p) => p.id === plan.id);
      if (plan.mode === "skip") {
        NodeAssert.equal(blocking.mode, "skip");
        NodeAssert.ok(!split.async.some((p) => p.id === plan.id));
        continue;
      }
      NodeAssert.equal(blocking.mode, "deferred");
      NodeAssert.equal(blocking.deferredMode, plan.mode);
      NodeAssert.deepEqual(
        split.async.find((p) => p.id === plan.id),
        plan,
      );
    }
    // Every planned check appears once in the blocking tier.
    NodeAssert.deepEqual(
      split.blocking.map((p) => p.id).sort(),
      scope.plans.map((p) => p.id).sort(),
    );
  });
});

NodeTest.test("a DB migration is never tiered: the full suite blocks", () => {
  withTree(({ reader }) => {
    const changedPaths = [
      "apps/server/src/personal/tier/core.ts",
      "apps/server/src/persistence/Migrations.ts",
    ];
    const scope = planChecks(changedPaths, { reader });
    const split = tierPlans(scope, { reader });
    NodeAssert.equal(split.tiered, false);
    NodeAssert.match(split.reason, /DB migration/);
    NodeAssert.deepEqual(split.blocking, scope.plans);
    NodeAssert.deepEqual(split.async, []);
    NodeAssert.deepEqual(plansForTier(scope, "full", { reader }), scope.plans);
  });
});

NodeTest.test("the seal accepts each tier's evidence and refuses a tier on a migration", () => {
  withTree(({ reader }) => {
    const changedPaths = ["apps/server/src/personal/tier/core.ts"];
    const scope = planChecks(changedPaths, { reader });
    const split = tierPlans(scope, { reader });
    NodeAssert.deepEqual(
      verify(reader, changedPaths, evidenceFor(split.blocking, { tier: "blocking", changedPaths })),
      [],
    );
    NodeAssert.deepEqual(
      verify(reader, changedPaths, evidenceFor(split.async, { tier: "async", changedPaths })),
      [],
    );
    NodeAssert.deepEqual(
      verify(reader, changedPaths, evidenceFor(scope.plans, { changedPaths })),
      [],
    );
    // Blocking evidence passed off as the full run is refused: e2e reads deferred.
    NodeAssert.notDeepEqual(
      verify(reader, changedPaths, evidenceFor(split.blocking, { changedPaths })),
      [],
    );
    // A deferred gate whose deferredMode was edited is refused.
    const forged = evidenceFor(split.blocking, { tier: "blocking", changedPaths });
    const deferred = forged.gates.find((g) => g.mode === "deferred");
    NodeAssert.ok(deferred, "the fixture defers at least one check");
    deferred.deferredMode = deferred.deferredMode === "whole" ? "selected" : "whole";
    NodeAssert.notDeepEqual(verify(reader, changedPaths, forged), []);

    const migration = [...changedPaths, "apps/server/src/persistence/Migrations.ts"];
    const full = planChecks(migration, { reader });
    NodeAssert.match(
      verify(
        reader,
        migration,
        evidenceFor(full.plans, { tier: "blocking", changedPaths: migration }),
      ).join(" "),
      /not tiered/,
    );
    NodeAssert.match(
      verify(reader, changedPaths, { ...evidenceFor([], { changedPaths }), tier: "later" }).join(
        " ",
      ),
      /unknown tier/,
    );
  });
});

// ---- release track (Faster releases step 3) ----

function appTree(version = "1.0.0", extra = {}) {
  const dir = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "gate-track-"));
  const write = (rel, text) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, rel)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, rel), text);
  };
  write(
    "apps/hbots-mobile/package.json",
    JSON.stringify({
      name: "hbots-mobile",
      version,
      dependencies: { "@t3tools/contracts": "workspace:*", ...extra },
    }),
  );
  write(
    "packages/contracts/package.json",
    JSON.stringify({
      name: "@t3tools/contracts",
      dependencies: { "@t3tools/shared": "workspace:*" },
    }),
  );
  write("packages/shared/package.json", JSON.stringify({ name: "@t3tools/shared" }));
  write("packages/provider-core/package.json", JSON.stringify({ name: "@t3tools/provider-core" }));
  return { dir, reader: fsReader(dir) };
}

NodeTest.test(
  "a server change, a version bump or app docs and tests are the server-only track",
  () => {
    const base = appTree("1.0.0");
    const head = appTree("1.0.1");
    try {
      const track = (changedPaths) =>
        releaseTrack({ changedPaths, reader: head.reader, baseReader: base.reader });
      for (const paths of [
        ["apps/server/src/http.ts"],
        ["apps/hbots-mobile/package.json", "scripts/personal/app-version.txt"],
        ["packages/provider-core/src/x.ts"],
        ["apps/hbots-mobile/.claude/skills/x/SKILL.md", "apps/hbots-mobile/src/a.test.ts"],
        [
          "apps/hbots-mobile/modules/m/android/src/test/java/T.kt",
          "packages/contracts/src/x.test.ts",
        ],
      ]) {
        const t = track(paths);
        NodeAssert.equal(t.track, "server-only", `${paths.join(", ")}: ${t.reason}`);
      }
      NodeAssert.deepEqual(track([]).packageDirs, ["packages/contracts/", "packages/shared/"]);
    } finally {
      NodeFS.rmSync(base.dir, { recursive: true, force: true });
      NodeFS.rmSync(head.dir, { recursive: true, force: true });
    }
  },
);

NodeTest.test(
  "app code, a package the app imports (transitively), the lockfile or a dependency is the full track",
  () => {
    const base = appTree("1.0.0");
    const head = appTree("1.0.1", { left: "1.2.3" });
    try {
      const track = (changedPaths, reader = head.reader) =>
        releaseTrack({ changedPaths, reader, baseReader: base.reader });
      for (const paths of [
        ["apps/hbots-mobile/src/App.tsx"],
        ["packages/contracts/src/x.ts"],
        ["packages/shared/src/y.ts"],
        ["pnpm-lock.yaml"],
        ["apps/hbots-mobile/modules/m/android/src/main/java/M.kt"],
      ])
        NodeAssert.equal(track(paths).track, "full", paths.join(", "));
      // A package.json change beyond the version (a new dependency) is an app change.
      const t = track(["apps/hbots-mobile/package.json"]);
      NodeAssert.equal(t.track, "full");
      NodeAssert.deepEqual(t.appPaths, ["apps/hbots-mobile/package.json"]);
      // No readable app package.json: unsure, so full.
      const empty = fsReader(NodePath.join(base.dir, "missing"));
      NodeAssert.equal(track(["apps/server/src/http.ts"], empty).track, "full");
    } finally {
      NodeFS.rmSync(base.dir, { recursive: true, force: true });
      NodeFS.rmSync(head.dir, { recursive: true, force: true });
    }
  },
);
