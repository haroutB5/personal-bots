// Changed-path planning for the release gates. One registry, one plan per check:
// a check is skipped, run whole, or run with selected args. A path outside every
// row, the toolchain list and NO_CHECK stops the plan instead of running all.
// The same module feeds the gate-evidence collector, the runner seal and the
// builder command, and reads at a commit so all three get the same answer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import {
  ALLOWANCE_FILE,
  FORK_TEST_ROOTS,
  KOTLIN_TEST,
  TEST_NAME,
  budgetLines,
  isForkTest,
  judgeChange,
  newAllowances,
} from "./testBudget.mjs";
import {
  SERVER_ALWAYS,
  SERVER_GATE_DIRS,
  fsReader,
  gitReader,
  selectServerTests,
} from "./serverTestSelect.mjs";

export const APP_VERSION = "scripts/personal/app-version.txt";
export const PARITY_MATRIX = "scripts/personal/parity/parity.json";
export const PKGS = "packages/";
export const SERVER_PKGS_EXCEPT = ["packages/personal-client/", "packages/client-runtime/"];

// Files that make every check run whole. A dependency or runtime change can move
// anything a gate reads.
export const TOOLCHAIN = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  ".node-version",
  "vite.config.ts",
  "tsconfig.base.json",
  "tsconfig.effect.json",
  ".npmrc",
  ".oxlintrc.json",
  ".oxfmtrc.json",
  ".env.test",
  "tsconfig.json",
  "vite.config.mts",
  "vitest.config.ts",
  "vitest.workspace.ts",
  "patches/",
  "scripts/lib/",
  // The root vite config imports infra/task-cache and loads the oxlint plugin as a
  // lint plugin; whether a gate lint reads it is unproven, so a change runs all.
  "infra/task-cache/",
  "oxlint-plugin-t3code/",
];

// Paths a gate reads although their area is not one of its inputs.
export const GATED_PATHS = [
  "apps/hbots-mobile/src/pairing.ts",
  "apps/hbots-mobile/src/dpop.ts",
  "docs/user/t3-connect-troubleshooting.md",
];
// Markdown under these trees can become a code input (a ?raw import, a prompt
// or skill file); markdown elsewhere is documentation.
export const CODE_TREES = ["apps/server/", "apps/web/", "packages/"];

// No check reads these. The completeness test keeps this list honest.
export const NO_CHECK = [
  "docs/",
  ".github/",
  "apps/desktop/",
  "apps/mobile/",
  "apps/marketing/",
  "infra/",
  "evals/",
  "native/",
  "assets/",
  "migrate/",
  "packaging/",
  "third-party-licenses/",
  ".vite-hooks/",
  ".vscode/",
  // Upstream script folders and root files, named one by one so a new one stops the plan.
  "scripts/fixtures/",
  "scripts/licenses/",
  "scripts/mobile-behavior/",
  "scripts/mobile-e2e/",
  "scripts/npm-launcher/",
  "scripts/scenarios/",
  ".coderabbit.config.ts",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  ".task-cache.json",
  ".vercelignore",
  "LICENSE",
  "knip.jsonc",
  "t3.json",
  "third-party-licenses.config.json",
  "scripts/personal/perf/",
  "scripts/personal/qa/",
  "scripts/personal/contract/",
  PARITY_MATRIX,
  ".repos/",
  ".agents/",
  ".claude/",
  ".cursor/",
  ".devcontainer/",
  ".macroscope/",
];

export const E2E_CORE_JOURNEYS = [
  "bots-list-chat",
  "new-chat-named",
  "delegate-task",
  "chats-search",
  "long-press-reply",
  "continue-chat",
  "revoked-session",
];
export const E2E_RESILIENCE_JOURNEYS = [
  "offline-queue",
  "offline-network",
  "cold-load-drop",
  "offline-screens",
  "stale-deploy",
];
// The resilience journeys check server behaviour too (exactly-once delivery in the
// server database, /version.txt, chunk 404s), so a server change runs them.
const E2E_RESILIENCE_INPUTS = [
  "apps/server/",
  "apps/web/",
  "packages/client-runtime/",
  "packages/personal-client/",
  "scripts/personal/e2e/",
  "scripts/personal/node/e2e-smoke.mjs",
  "scripts/personal/testing/",
];

// One row per check. `inputs` and `except` are prefixes, exact paths, or
// prefixes with one `*` segment. `select` names the selector that fills args.
export const CHECKS = {
  "server-tests": {
    inputs: [
      "apps/server/",
      PKGS,
      ...GATED_PATHS,
      "scripts/personal/adblock/",
      "scripts/personal/dsh-runtime/",
      "scripts/personal/updates/",
      "scripts/personal/sync/",
      "scripts/personal/testing/",
    ],
    except: SERVER_PKGS_EXCEPT,
    select: "serverTests@1",
  },
  "server-tsc": {
    inputs: ["apps/server/", PKGS],
    except: SERVER_PKGS_EXCEPT,
  },
  "web-tests": {
    inputs: ["apps/web/", PKGS],
  },
  "web-tsc": {
    inputs: ["apps/web/", PKGS],
  },
  "personal-client": {
    inputs: [
      "packages/personal-client/",
      "packages/client-runtime/",
      "packages/contracts/",
      "packages/shared/",
    ],
  },
  "hbots-mobile": {
    inputs: ["apps/hbots-mobile/", PKGS, APP_VERSION],
    except: ["apps/hbots-mobile/modules/*/android/"],
  },
  "hbots-mobile-kotlin": {
    inputs: [
      "apps/hbots-mobile/modules/*/android/",
      "apps/hbots-mobile/modules/*/expo-module.config.json",
      "apps/hbots-mobile/plugins/",
      "apps/hbots-mobile/app.config.ts",
    ],
    select: "kotlinModules@1",
  },
  e2e: {
    inputs: [
      "apps/server/",
      "apps/web/",
      PKGS,
      "scripts/personal/e2e/",
      "scripts/personal/node/e2e-smoke.mjs",
      "scripts/personal/testing/",
    ],
    select: "e2eJourneys@1",
  },
  parity: {
    inputs: [
      "apps/web/",
      "apps/hbots-mobile/",
      "packages/personal-client/",
      "scripts/personal/parity/",
    ],
    except: ["apps/hbots-mobile/package.json", PARITY_MATRIX],
  },
  "release-tools": {
    inputs: [
      "scripts/personal/linux/",
      "scripts/personal/node/",
      "scripts/personal/migration-check.cjs",
      "scripts/personal/sqlite-",
      "scripts/personal/copy-externals.mjs",
      "scripts/personal/idle-classification-",
      "scripts/personal/dsh-runtime/",
      "scripts/personal/release-runner/",
    ],
    select: "releaseTools@1",
  },
};
export const CHECK_IDS = Object.keys(CHECKS);

// Files a test runner loads through its config, so no import reaches them: a
// vitest or vite config, a setup or globalSetup file, shard weights, a tsconfig,
// a package manifest, and the shared test helpers. Any of them in a check's
// inputs runs that check whole, never selected.
const WHOLE_TRIGGERS = [
  /(?:^|\/)(?:vite|vitest)(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /\.setup\.[cm]?[jt]sx?$/,
  /(?:^|\/)[^/]*[gG]lobalSetup[^/]*\.[cm]?[jt]sx?$/,
  /(?:^|\/)shardWeights\.json$/,
  /(?:^|\/)package\.json$/,
  /^apps\/server\/src\/testUtils\//,
  /^packages\/shared\/src\/testing\//,
];
const forcesWhole = (file) => WHOLE_TRIGGERS.some((pattern) => pattern.test(file));

const matches = (file, pattern) => {
  if (pattern.includes("*")) {
    const body = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]+");
    return new RegExp(`^${body}`).test(file);
  }
  // A trailing "-" names a file family (`sqlite-*.cjs`); a trailing "/" a folder.
  return pattern.endsWith("/") || pattern.endsWith("-")
    ? file.startsWith(pattern)
    : file === pattern;
};
const matchesAny = (file, patterns) => patterns.some((pattern) => matches(file, pattern));
const isPlainDoc = (file) =>
  file.endsWith(".md") && !CODE_TREES.some((tree) => file.startsWith(tree));
const isUnsafe = (file) =>
  !file || file.startsWith("/") || file.includes("\\") || file.split("/").includes("..");

/**
 * How one path is read: `toolchain`, `none`, one or more check ids, or unmapped.
 * Plain docs and exact NO_CHECK paths win over a row's broad prefix, which is
 * why a mobile README does not run the mobile gate.
 */
export function classifyPath(file) {
  if (typeof file !== "string" || isUnsafe(file)) return { kind: "unmapped", checks: [] };
  if (matchesAny(file, TOOLCHAIN)) return { kind: "toolchain", checks: [] };
  // A file a gate reads by name runs that gate and also every check of its own
  // area, so the phone tests still run for apps/hbots-mobile/src/pairing.ts.
  const named = GATED_PATHS.includes(file)
    ? CHECK_IDS.filter((id) => CHECKS[id].inputs.includes(file))
    : [];
  if (isPlainDoc(file) || NO_CHECK.includes(file))
    return named.length ? { kind: "check", checks: named } : { kind: "none", checks: [] };
  const checks = CHECK_IDS.filter((id) => {
    const row = CHECKS[id];
    return (
      named.includes(id) ||
      (row.inputs.some((pattern) => matches(file, pattern)) && !matchesAny(file, row.except ?? []))
    );
  });
  if (checks.length) return { kind: "check", checks };
  if (matchesAny(file, NO_CHECK)) return { kind: "none", checks: [] };
  // A ps1 helper directly under scripts/personal is retired tooling.
  if (
    file.startsWith("scripts/personal/") &&
    !file.slice("scripts/personal/".length).includes("/") &&
    file.endsWith(".ps1")
  )
    return { kind: "none", checks: [] };
  // Upstream scripts sitting directly under scripts/ are not shipped and no gate reads them.
  if (/^scripts\/[^/]+\.(?:ts|mjs|cjs|js|json|py|ps1|sh)$/.test(file))
    return { kind: "none", checks: [] };
  return { kind: "unmapped", checks: [] };
}

const moduleTask = (name) => `:${name}:testDebugUnitTest`;

// Every module with an android folder, and the ones among them that have unit tests.
function kotlinModules(reader) {
  const tested = new Set();
  const all = new Set();
  for (const file of reader.listFiles("apps/hbots-mobile/modules")) {
    const module = /^apps\/hbots-mobile\/modules\/([^/]+)\/android\//.exec(file);
    if (module) all.add(module[1]);
    const test = /^apps\/hbots-mobile\/modules\/([^/]+)\/android\/src\/test\//.exec(file);
    if (test) tested.add(test[1]);
  }
  const deps = new Map();
  for (const name of all) {
    const gradle = ["build.gradle", "build.gradle.kts"]
      .map((file) => reader.read(`apps/hbots-mobile/modules/${name}/android/${file}`) ?? "")
      .join("\n")
      // A commented-out project() is not a dependency. Strings are matched first and
      // kept, so a "/*" in a glob or a "//" in a URL never opens a comment.
      .replace(
        /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        (_match, string) => string ?? " ",
      );
    deps.set(
      name,
      // Any configuration (implementation, api, testImplementation, ...) and either
      // call form: `x project(':a')` or `x(project(":a"))`, with `path:` or the
      // Kotlin DSL `path =` allowed.
      [...gradle.matchAll(/project\(\s*(?:path\s*[:=]\s*)?['"]:([^'":]+)['"]/g)].map((m) => m[1]),
    );
  }
  return { names: [...tested].sort(), all, deps };
}

function selectKotlin({ reader, changedPaths }) {
  const { names, all, deps } = kotlinModules(reader);
  const everyTask = names.map(moduleTask);
  const hit = new Set();
  for (const file of changedPaths) {
    if (file === "apps/hbots-mobile/app.config.ts" || file.startsWith("apps/hbots-mobile/plugins/"))
      return { args: everyTask, count: everyTask.length, unit: "Gradle tasks" };
    const moduleFile =
      /^apps\/hbots-mobile\/modules\/([^/]+)\/(?:android\/|expo-module\.config\.json)/.exec(file);
    if (moduleFile) hit.add(moduleFile[1]);
  }
  const selected = new Set(hit);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, dependencies] of deps) {
      if (selected.has(name)) continue;
      if (dependencies.some((dep) => selected.has(dep))) {
        selected.add(name);
        grew = true;
      }
    }
  }
  const args = names.filter((name) => selected.has(name)).map(moduleTask);
  // A changed module with no unit tests and no tested dependent has nothing to run.
  const untested = [...hit].filter((name) => !names.includes(name) && all.has(name)).sort();
  return { args, count: args.length, unit: "Gradle tasks", untested };
}

function selectE2e({ changedPaths }) {
  const resilience = changedPaths.some((file) => matchesAny(file, E2E_RESILIENCE_INPUTS));
  const args = [...E2E_CORE_JOURNEYS, ...(resilience ? E2E_RESILIENCE_JOURNEYS : [])];
  return { args, count: args.length, unit: "journeys" };
}

const RELEASE_TOOL_GROUPS = [
  {
    prefix: "scripts/personal/linux/hbots-release/",
    tests: ["scripts/personal/linux/hbots-release/tests"],
  },
  {
    prefix: "scripts/personal/linux/dev-team-tools/",
    tests: [
      "scripts/personal/linux/dev-team-tools/tools.test.mjs",
      "scripts/personal/linux/dev-team-tools/linux-ports.test.mjs",
    ],
  },
  {
    prefix: "scripts/personal/linux/",
    tests: [
      "scripts/personal/linux/hbots-release/tests",
      "scripts/personal/linux/dev-team-tools/tools.test.mjs",
      "scripts/personal/linux/dev-team-tools/linux-ports.test.mjs",
    ],
  },
  { prefix: "scripts/personal/node/", tests: ["scripts/personal/node/test"] },
  {
    prefix: "scripts/personal/migration-check.cjs",
    tests: ["scripts/personal/node/test"],
  },
  {
    prefix: "scripts/personal/sqlite-",
    tests: ["scripts/personal/sqlite-snapshot.test.cjs", "scripts/personal/node/test"],
  },
  {
    prefix: "scripts/personal/copy-externals.mjs",
    tests: ["scripts/personal/node/test"],
  },
  {
    prefix: "scripts/personal/idle-classification-",
    tests: ["scripts/personal/idle-classification-16654.test.mjs"],
  },
];

function expandTests(reader, entries) {
  const files = new Set();
  for (const entry of entries) {
    if (reader.exists(entry)) files.add(entry);
    else
      for (const file of reader.listFiles(entry))
        if (/\.test\.(?:mjs|cjs|js)$/.test(file)) files.add(file);
  }
  return [...files].sort();
}

// A release-tool test reads files by name from wherever they sit, so the folder
// groups above are not enough. A changed file also selects every test whose source
// names its file name or the folder directly above it. Names every test mentions
// say nothing and are left out.
const NOT_A_READ_NAME = new Set([
  "package.json",
  "package-lock.json",
  "README.md",
  "index.mjs",
  "index.cjs",
  "index.js",
]);
const NOT_A_READ_DIR = new Set([
  "scripts",
  "personal",
  "linux",
  "node",
  "lib",
  "bin",
  "test",
  "tests",
  "fixtures",
  "golden",
  "fake",
  "hbots-release",
  "dev-team-tools",
]);

function readNames(file) {
  const parts = file.split("/");
  const name = parts.at(-1);
  const dir = parts.at(-2);
  return [
    ...(NOT_A_READ_NAME.has(name) ? [] : [name]),
    ...(dir && !NOT_A_READ_DIR.has(dir) ? [dir] : []),
  ];
}

function testsReading({ reader, changedPaths, tests }) {
  const names = new Set(
    changedPaths
      .filter((file) => classifyPath(file).checks.includes("release-tools"))
      .flatMap(readNames),
  );
  if (names.size === 0) return [];
  const escaped = [...names].map((name) => name.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  const mention = new RegExp(`(?<![\\w.-])(?:${escaped.join("|")})(?![\\w-])`);
  reader.prefetch?.(tests);
  return tests.filter((test) => mention.test(reader.read(test) ?? ""));
}

function selectReleaseTools({ reader, changedPaths }) {
  const everyTest = expandTests(reader, [
    ...new Set(RELEASE_TOOL_GROUPS.flatMap((group) => group.tests)),
  ]);
  const tests = new Set();
  for (const file of changedPaths)
    for (const group of RELEASE_TOOL_GROUPS)
      if (file.startsWith(group.prefix))
        for (const test of expandTests(reader, group.tests)) tests.add(test);
  for (const test of testsReading({ reader, changedPaths, tests: everyTest })) tests.add(test);
  const args = [...tests].sort();
  return { args, count: args.length, unit: "test files" };
}

// Test files that some gate command runs, read off the gate commands in
// gates-linux.scoped.json. Everything else that is a test by name runs in no gate, so a
// plan never looks as if it ran a changed test that nothing ran.
const GATE_TEST_RULES = [
  // server-tests
  (file) =>
    SERVER_GATE_DIRS.some((dir) => file.startsWith(`apps/server/${dir}/`)) &&
    /\.test\.tsx?$/.test(file),
  // web-tests: the unit project, so no .browser.test files
  (file) =>
    !/\.browser\.test\./.test(file) &&
    /\.test\.tsx?$/.test(file) &&
    (file.startsWith("apps/web/src/features/personal/") ||
      file === "apps/web/src/authBootstrap.test.ts" ||
      file === "apps/web/src/components/chat/providerIconUtils.test.ts"),
  // hbots-mobile: vite.config.ts includes src and scripts .test.ts
  (file) => /^apps\/hbots-mobile\/(?:src|scripts)\/.+\.test\.ts$/.test(file),
  // personal-client: no vite config, so every test file of the package
  (file) => file.startsWith("packages/personal-client/") && /\.test\.tsx?$/.test(file),
  (file) => KOTLIN_TEST.test(file),
];

/** Changed test files, present at the head, that no gate runs. */
export function testsNoGateRuns(changedPaths, reader) {
  const releaseTools = new Set(
    expandTests(reader, [...new Set(RELEASE_TOOL_GROUPS.flatMap((group) => group.tests))]),
  );
  return changedPaths.filter(
    (file) =>
      (TEST_NAME.test(file) || KOTLIN_TEST.test(file)) &&
      reader.exists(file) &&
      !releaseTools.has(file) &&
      !GATE_TEST_RULES.some((rule) => rule(file)),
  );
}

function selectFor(id, { reader, changedPaths }) {
  if (id === "server-tests") {
    const found = selectServerTests({ reader, changedPaths });
    // The always-run tests are the least a server-tests run is allowed to be, so a
    // selection no test reaches names them instead of naming nothing.
    const args = found.length ? found : [...SERVER_ALWAYS];
    return { args, count: args.length, unit: "test files" };
  }
  if (id === "hbots-mobile-kotlin") return selectKotlin({ reader, changedPaths });
  if (id === "e2e") return selectE2e({ changedPaths });
  if (id === "release-tools") return selectReleaseTools({ reader, changedPaths });
  throw new Error(`check ${id} has no selector`);
}

function wholeArgs(id, reader) {
  if (id === "server-tests") return [...SERVER_GATE_DIRS];
  if (id === "hbots-mobile-kotlin") return kotlinModules(reader).names.map(moduleTask);
  if (id === "e2e") return [...E2E_CORE_JOURNEYS, ...E2E_RESILIENCE_JOURNEYS];
  if (id === "release-tools")
    return expandTests(reader, [...new Set(RELEASE_TOOL_GROUPS.flatMap((group) => group.tests))]);
  return undefined;
}

const listed = (files) => files.slice(0, 4).join(", ") + (files.length > 4 ? ", ..." : "");
const describeRow = (row) =>
  row.inputs
    .filter((pattern) => !GATED_PATHS.includes(pattern))
    .map((pattern) => (pattern.endsWith("/") ? pattern.slice(0, -1) : pattern))
    .join(", ") + (row.except?.length ? ` (not ${row.except.join(", ")})` : "");

/**
 * Plan every check for a changed-path list. Returns `{error:"unmapped", paths}`
 * for a path no row, no toolchain entry and no NO_CHECK entry covers, or
 * `{changedPaths, plans}` with one skip, whole or selected plan per check.
 */
export function planChecks(paths, options = {}) {
  const reader = options.reader ?? fsReader(NodeProcess.cwd());
  if (!Array.isArray(paths) || paths.length === 0)
    return {
      changedPaths: [],
      plans: CHECK_IDS.map((id) => ({
        id,
        mode: "whole",
        reason: "no changed paths to classify; every check runs whole",
        ...(wholeArgs(id, reader) ? { args: wholeArgs(id, reader) } : {}),
      })),
      summary: "RUN every check whole (no changed paths to classify)",
    };
  const changedPaths = [];
  const toolchain = [];
  const hits = Object.fromEntries(CHECK_IDS.map((id) => [id, []]));
  const unmapped = [];
  for (const value of paths) {
    const file = typeof value === "string" ? value.trim() : value;
    if (typeof file !== "string" || isUnsafe(file)) {
      unmapped.push(String(value));
      continue;
    }
    changedPaths.push(file);
    const kind = classifyPath(file);
    if (kind.kind === "unmapped") unmapped.push(file);
    else if (kind.kind === "toolchain") toolchain.push(file);
    else for (const id of kind.checks) hits[id].push(file);
  }
  if (unmapped.length) return { error: "unmapped", paths: unmapped };
  if (toolchain.length)
    return {
      changedPaths,
      plans: CHECK_IDS.map((id) => ({
        id,
        mode: "whole",
        reason: `toolchain changed: ${listed(toolchain)}; every check runs whole`,
        ...(wholeArgs(id, reader) ? { args: wholeArgs(id, reader) } : {}),
      })),
      summary: `RUN every check whole (toolchain changed: ${listed(toolchain)})`,
      notRun: testsNoGateRuns(changedPaths, reader),
    };
  const plans = CHECK_IDS.map((id) => {
    const row = CHECKS[id];
    if (hits[id].length === 0)
      return {
        id,
        mode: "skip",
        reason: `no changed path is an input of ${id}: ${describeRow(row)}`,
      };
    if (!row.select)
      return { id, mode: "whole", reason: `${id} inputs changed: ${listed(hits[id])}` };
    const infra = hits[id].filter(forcesWhole);
    if (infra.length)
      return {
        id,
        mode: "whole",
        reason: `${id} test setup or config changed: ${listed(infra)}; runs whole`,
        ...(wholeArgs(id, reader) ? { args: wholeArgs(id, reader) } : {}),
      };
    const selection = selectFor(id, { reader, changedPaths });
    // A selection that names nothing is never a green run: say why it is a skip.
    if (selection.args.length === 0)
      return {
        id,
        mode: "skip",
        reason: `${id} inputs changed (${listed(hits[id])}) but ${
          selection.untested?.length
            ? `${selection.untested.join(", ")} has no unit tests and no tested dependent`
            : "the selector found nothing to run"
        }`,
      };
    return {
      id,
      mode: "selected",
      reason: `${id} inputs changed: ${listed(hits[id])}; selected ${selection.count} ${selection.unit}`,
      selector: row.select,
      args: selection.args,
    };
  });
  const run = plans.filter((plan) => plan.mode !== "skip");
  const selected = run.filter((plan) => plan.mode === "selected");
  return {
    changedPaths,
    plans,
    notRun: testsNoGateRuns(changedPaths, reader),
    summary:
      run.length === 0
        ? "SKIP every check (no input changed)"
        : `RUN ${run.map((plan) => plan.id).join(", ")} (${selected.length} selected, ${run.length - selected.length} whole); SKIP ${
            plans
              .filter((plan) => plan.mode === "skip")
              .map((plan) => plan.id)
              .join(", ") || "none"
          }`,
  };
}

const shellArg = (value) =>
  /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

const fill = (command, plan) =>
  command.includes("{args}")
    ? command.replaceAll(
        "{args}",
        (plan.args ?? []).map(shellArg).join(plan.id === "e2e" ? "," : " "),
      )
    : command;

/**
 * Shell lanes for one plan. A skip has none; a whole check with `concurrent`
 * keeps its shards; a selected server-tests set over 150 files splits into two
 * lanes of named halves, the point where one lane stopped fitting the 5 GiB soft cap.
 */
export function commandsFor(plan, def) {
  if (!def || plan.mode === "skip") return [];
  if (plan.mode === "selected" && !(plan.args?.length > 0))
    throw new Error(`${plan.id}: a selected plan with no args would run nothing`);
  if (plan.mode === "whole" && def.concurrent)
    return def.concurrent.map((lane) => lane.map((command) => fill(command, plan)));
  const commands = def.commands ?? [];
  if (plan.id === "server-tests" && plan.mode === "selected" && plan.args.length > 150) {
    // Two lanes, each with its own named half. No --shard: vitest applies a shard
    // to the files already named, so sharding a half would drop half of it.
    const half = Math.ceil(plan.args.length / 2);
    const lane = (args) => [fill(commands[0], { ...plan, args })];
    return [lane(plan.args.slice(0, half)), lane(plan.args.slice(half))];
  }
  return [commands.map((command) => fill(command, plan))];
}

/**
 * The runner-seal check. Recomputes every plan from the live-to-release diff and
 * refuses any gate whose mode, args, base or changedPaths differ, and any
 * planned check that is not in the evidence exactly once.
 */
export function verifyPlans({ evidence, liveSha, releaseSha, changedPaths, reader }) {
  const problems = [];
  if (!/^[a-f0-9]{40}$/.test(liveSha ?? ""))
    problems.push(
      `cannot verify gate plans: the live release ${liveSha ?? "(missing)"} is not a commit`,
    );
  if (!/^[a-f0-9]{40}$/.test(releaseSha ?? ""))
    problems.push(
      `cannot verify gate plans: the release ${releaseSha ?? "(missing)"} is not a commit`,
    );
  if (problems.length) return problems;
  const scope = planChecks(changedPaths, { reader });
  if (scope.error === "unmapped")
    return [`the live-to-release diff has unmapped paths: ${scope.paths.join(", ")}`];
  const expected = [...scope.changedPaths].sort();
  const byId = new Map(scope.plans.map((plan) => [plan.id, plan]));
  const gates = Array.isArray(evidence?.gates) ? evidence.gates : [];
  if (gates.length === 0) problems.push("the evidence has no gates");
  for (const gate of gates) {
    const plan = byId.get(gate?.id);
    if (!plan) {
      problems.push(`gate ${gate?.id ?? "(missing id)"} is not a check in the registry`);
      continue;
    }
    if (gate.mode !== plan.mode)
      problems.push(
        `evidence gate ${gate.id} is ${gate.mode ?? "(missing mode)"}, the recomputed plan is ${plan.mode}`,
      );
    if (gate.baseSha !== liveSha)
      problems.push(
        `gate ${gate.id} claims base ${gate.baseSha ?? "(missing)"}, live is ${liveSha}`,
      );
    const claimed = Array.isArray(gate.changedPaths) ? [...gate.changedPaths].sort() : [];
    if (
      claimed.length !== expected.length ||
      claimed.some((file, index) => file !== expected[index])
    )
      problems.push(`gate ${gate.id} changedPaths differ from the live-to-release diff`);
    if (plan.mode === "selected" && gate.selector !== plan.selector)
      problems.push(
        `gate ${gate.id} selector ${gate.selector ?? "(missing)"} is not ${plan.selector}`,
      );
    if (plan.mode !== "skip" && plan.args) {
      const args = Array.isArray(gate.args) ? gate.args : null;
      if (
        !args ||
        args.length !== plan.args.length ||
        args.some((arg, index) => arg !== plan.args[index])
      )
        problems.push(`gate ${gate.id} args differ from the recomputed plan`);
      // The journeys that ran are the journeys that were planned.
      // A missing or non-list `journeys` is as wrong as a different list.
      if (gate.id === "e2e") {
        const ran = Array.isArray(gate.journeys)
          ? gate.journeys.map((journey) => journey?.id).sort()
          : null;
        const planned = [...plan.args].sort();
        if (!ran)
          problems.push(
            `gate e2e has no journeys list; gate e2e journeys differ from the planned journeys`,
          );
        else if (ran.length !== planned.length || ran.some((id, index) => id !== planned[index]))
          problems.push(`gate e2e journeys differ from the planned journeys`);
      }
    }
  }
  // Exactly one evidence gate per planned check: a gate left out or repeated is
  // a refusal, whatever mode the plan gave it.
  const count = new Map();
  for (const gate of gates) count.set(gate?.id, (count.get(gate?.id) ?? 0) + 1);
  for (const plan of scope.plans) {
    const seen = count.get(plan.id) ?? 0;
    if (seen === 0)
      problems.push(`gate ${plan.id} is planned ${plan.mode} but missing from the evidence`);
    else if (seen > 1) problems.push(`gate ${plan.id} appears ${seen} times in the evidence`);
  }
  return problems;
}

const gitOut = (repo, args) =>
  NodeChildProcess.execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
const gitHas = (repo, rev, path) =>
  NodeChildProcess.spawnSync("git", ["-C", repo, "cat-file", "-e", `${rev}:${path}`]).status === 0;
const gitFile = (repo, rev, path) =>
  gitHas(repo, rev, path) ? gitOut(repo, ["show", `${rev}:${path}`]) : null;

function forkLineCounts(repo, from, to) {
  const counts = new Map();
  const fields = gitOut(repo, [
    "diff",
    "--no-renames",
    "--numstat",
    "-z",
    from,
    to,
    "--",
    ...FORK_TEST_ROOTS,
  ]).split("\0");
  for (const field of fields) {
    const [added, deleted, ...path] = field.split("\t");
    if (path.length === 0) continue;
    counts.set(path.join("\t"), { added: Number(added) || 0, deleted: Number(deleted) || 0 });
  }
  return counts;
}

/**
 * The test-line budget of one change: a list of `{ base, head }` diffs summed
 * together. Returns the judged change, the problems that make it fail whatever
 * its size, and the lines to print.
 */
export function budgetOfChange(repo, { id, steps }) {
  const net = new Map();
  const code = { added: 0, deleted: 0 };
  const problems = [];
  const rows = [];
  let limit;
  for (const { base, head } of steps) {
    for (const [path, { added, deleted }] of forkLineCounts(repo, base, head)) {
      if (isForkTest(path)) net.set(path, (net.get(path) ?? 0) + added - deleted);
      else {
        code.added += added;
        code.deleted += deleted;
      }
    }
    const found = newAllowances(
      gitFile(repo, base, ALLOWANCE_FILE),
      gitFile(repo, head, ALLOWANCE_FILE),
      { exists: (path) => gitHas(repo, head, path) },
    );
    limit ??= found.limit;
    rows.push(...found.rows);
    problems.push(...found.problems);
  }
  const result = judgeChange({
    id,
    deltas: [...net]
      .filter(([, lines]) => lines !== 0)
      .map(([path, lines]) => ({ path, net: lines })),
    limit,
    allowance: rows.sort((a, b) => b.lines - a.lines)[0],
    code,
  });
  return {
    result,
    problems,
    failed: problems.length > 0 || result.verdict === "over",
    lines: [...problems.map((problem) => `FAIL test budget: ${problem}`), ...budgetLines(result)],
  };
}

const mergeLabel = (repo, sha) =>
  /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(
    gitOut(repo, ["log", "-1", "--format=%s", sha]),
  )?.[1] ?? `merge ${sha.slice(0, 10)}`;

/**
 * The budget of every change a release carries. Each merge on the first-parent
 * line is one change, measured from where its branch left trunk. A merge of trunk
 * into a branch is skipped, and the commits made straight on the line are one more change.
 */
export function budgetOfRelease(repo, liveSha, releaseSha) {
  const changes = [];
  const direct = [];
  const log = gitOut(repo, [
    "rev-list",
    "--first-parent",
    "--parents",
    `${liveSha}..${releaseSha}`,
  ]);
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, first, ...others] = line.split(" ");
    if (!first) continue;
    if (others.length === 0) direct.push({ base: first, head: sha });
    else if (others.length > 1)
      changes.push({ id: mergeLabel(repo, sha), steps: [{ base: first, head: sha }] });
    else if (
      NodeChildProcess.spawnSync("git", [
        "-C",
        repo,
        "merge-base",
        "--is-ancestor",
        others[0],
        liveSha,
      ]).status !== 0
    )
      changes.push({
        id: mergeLabel(repo, sha),
        steps: [{ base: gitOut(repo, ["merge-base", first, others[0]]).trim(), head: others[0] }],
      });
  }
  if (direct.length) changes.push({ id: "commits made on the release line", steps: direct });
  const reports = changes.map((change) => budgetOfChange(repo, change));
  return {
    reports,
    lines: reports.flatMap((report) => report.lines),
    problems: reports
      .filter((report) => report.failed)
      .flatMap((report) =>
        report.lines.filter((line) => line.startsWith("FAIL")).map((line) => line.slice(5)),
      ),
  };
}

const invokedDirectly = () => {
  try {
    return NodePath.resolve(NodeProcess.argv[1] ?? "") === NodeURL.fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

function parseCli(argv) {
  const out = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--commands" || arg === "--json") out[arg.slice(2)] = true;
    else if (arg === "--base" || arg === "--head" || arg === "--repo" || arg === "--gates-json")
      out[arg.slice(2)] = argv[(index += 1)];
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else out.positional.push(arg);
  }
  if (!out.base && out.positional[0]) out.base = out.positional[0];
  if (!out.head && out.positional[1]) out.head = out.positional[1];
  if (!out.repo && out.positional[2]) out.repo = out.positional[2];
  return out;
}

function printPlan(scope, toError = false) {
  const log = toError ? console.error : console.log;
  log(`gate scope: ${scope.summary}`);
  for (const plan of scope.plans) {
    const args = plan.mode === "selected" ? ` [${plan.args.length}]` : "";
    log(`  ${plan.id}: ${plan.mode}${args} (${plan.reason})`);
  }
  for (const file of scope.notRun ?? []) log(`not run by any gate: ${file}`);
}

if (invokedDirectly()) {
  let options;
  try {
    options = parseCli(NodeProcess.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    NodeProcess.exit(2);
  }
  if (!options.base || !options.head) {
    console.error(
      "Usage: node gateScope.mjs --base <rev> --head <rev> [--repo DIR] [--gates-json FILE] [--commands|--json]",
    );
    NodeProcess.exit(2);
  }
  const repo = options.repo ?? ".";
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    const baseSha = git("rev-parse", "--verify", `${options.base}^{commit}`);
    const headSha = git("rev-parse", "--verify", `${options.head}^{commit}`);
    // A branch that trunk has moved past is planned from where it left trunk, so
    // trunk's newer changes do not count as the branch's own.
    const mergeBase = git("merge-base", baseSha, headSha);
    const changedPaths = git("diff", "--no-renames", "--name-only", "-z", mergeBase, headSha)
      .split("\0")
      .filter(Boolean);
    const reader = gitReader(repo, headSha);
    const scope = planChecks(changedPaths, { reader });
    if (scope.error === "unmapped") {
      console.error(
        `FAIL: unmapped path${scope.paths.length === 1 ? "" : "s"} ${scope.paths.join(", ")}. Add it to a CHECKS row, NO_CHECK or TOOLCHAIN in scripts/personal/linux/hbots-release/lib/gateScope.mjs.`,
      );
      NodeProcess.exit(2);
    }
    const branch =
      options.head === "HEAD" ? git("rev-parse", "--abbrev-ref", "HEAD") : options.head;
    const budget = budgetOfChange(repo, {
      id: branch === "HEAD" ? headSha.slice(0, 10) : branch,
      steps: [{ base: mergeBase, head: headSha }],
    });
    const result = { baseSha: mergeBase, requestedBase: baseSha, headSha, ...scope };
    if (options.json) {
      console.log(
        JSON.stringify(
          { ...result, budget: { ...budget.result, problems: budget.problems } },
          null,
          2,
        ),
      );
    } else if (options.commands) {
      printPlan(result, true);
      for (const line of budget.lines) console.error(line);
      // The gate commands ship with this planner, so read them from this checkout:
      // the head's own copy may predate the {args} placeholders.
      const defsFile =
        options["gates-json"] ??
        NodePath.resolve(
          NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
          "../../../node/gates-linux.scoped.json",
        );
      const defs = JSON.parse(NodeFS.readFileSync(defsFile, "utf8"));
      for (const plan of result.plans) {
        if (plan.mode === "skip" || plan.id === "e2e") continue;
        const def = defs.find((entry) => entry.id === plan.id);
        if (!def) continue;
        const cwd = def.cwd ?? ".";
        for (const lane of commandsFor(plan, def))
          for (const command of lane)
            console.log(cwd === "." ? command : `cd ${cwd} && ${command}`);
      }
    } else {
      printPlan(result);
      for (const line of budget.lines) (budget.failed ? console.error : console.log)(line);
    }
    if (budget.failed) NodeProcess.exit(2);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    NodeProcess.exit(2);
  }
}

export { fsReader, gitReader };
