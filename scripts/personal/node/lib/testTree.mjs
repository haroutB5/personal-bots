// A worktree must run its gates on its OWN dependencies.
//
// Worktrees in this repo have borrowed each other's node_modules by symlink
// (see the app sheet). pnpm then resolves workspace packages through the other
// checkout: `@t3tools/client-runtime` comes from a different commit, the web
// suite fails en masse with "act is not a function", and the failure looks like
// the change under test. Refuse with a clear message instead.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const WORKSPACE_PACKAGE = "@t3tools/client-runtime";

function isInside(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

function moduleLinks({ repoRoot, packageDir }) {
  const problems = [];
  for (const dir of new Set([repoRoot, packageDir])) {
    const modules = path.join(dir, "node_modules");
    let stat;
    try {
      stat = fs.lstatSync(modules);
    } catch {
      continue;
    }
    if (!stat.isSymbolicLink()) continue;
    const target = fs.realpathSync(modules);
    if (!isInside(repoRoot, target)) problems.push({ modules, target });
  }
  return problems;
}

function packageOutsideRepo({ repoRoot, packageDir }) {
  const entry = path.join(packageDir, "__gate_resolve__.mjs");
  const require = createRequire(entry);
  try {
    // A subpath the package exports; package.json itself is not exported.
    const resolved = fs.realpathSync(require.resolve(`${WORKSPACE_PACKAGE}/device/stream`));
    return isInside(repoRoot, resolved) ? null : resolved;
  } catch (error) {
    return { missing: error.message };
  }
}

/**
 * Returns the problems that make this checkout unsafe for a gate run; an empty
 * array means the tree is clean. `packageDir` is the package the gate runs in
 * (for example `<repo>/apps/web`).
 */
export function checkTestTree({ repoRoot, packageDir }) {
  const root = path.resolve(repoRoot);
  const pkg = path.resolve(packageDir);
  const problems = [];
  for (const link of moduleLinks({ repoRoot: root, packageDir: pkg })) {
    problems.push(
      `${link.modules} is a symlink to ${link.target}, another checkout. ` +
        "Its workspace packages resolve from that checkout, so tests fail en masse.",
    );
  }
  if (problems.length === 0) {
    const outside = packageOutsideRepo({ repoRoot: root, packageDir: pkg });
    if (outside && outside.missing) {
      problems.push(`${WORKSPACE_PACKAGE} does not resolve from ${pkg}: ${outside.missing}`);
    } else if (outside) {
      problems.push(
        `${WORKSPACE_PACKAGE} resolves to ${outside}, outside this checkout. ` +
          "The gate would test another worktree's code.",
      );
    }
  }
  return problems;
}

/** The message the gate prints, or null when the tree is clean. */
export function testTreeError({ repoRoot, packageDir }) {
  const problems = checkTestTree({ repoRoot, packageDir });
  if (problems.length === 0) return null;
  return [
    "Refusing to run this gate: the test environment borrows another checkout.",
    ...problems.map((problem) => `  - ${problem}`),
    "Run `vp i` in this worktree (its own node_modules), then rerun the gate.",
  ].join("\n");
}
