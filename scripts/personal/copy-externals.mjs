// Copies the server bundle's runtime externals (node-pty, msgpackr-extract,
// playwright-core, ... see scripts/lib/cli-external-packages.ts) out of the
// checkout's pnpm store into a release's own node_modules, dereferenced and
// flat, so a release keeps working after a later `vp i` or after the checkout
// that built it is gone. Same selection as scripts/build-cli-archive.ts: the
// server's direct dependencies that are runtime externals, plus everything
// they depend on.
//
// Usage: node copy-externals.mjs <apps/server dir> <target node_modules dir>
// Prints one JSON summary line. Exits non-zero when a root is missing.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [serverDirArg, targetArg] = process.argv.slice(2);
if (!serverDirArg || !targetArg) {
  console.error("usage: node copy-externals.mjs <apps/server dir> <target node_modules dir>");
  process.exit(2);
}
const serverDir = NodeFS.realpathSync(serverDirArg);
const target = NodePath.resolve(targetArg);
const repoRoot = NodePath.resolve(serverDir, "..", "..");
const { selectCliRuntimeExternalDependencies } = await import(
  NodeURL.pathToFileURL(NodePath.join(repoRoot, "scripts", "lib", "cli-external-packages.ts")).href
);

const readJson = (file) => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const serverPackage = readJson(NodePath.join(serverDir, "package.json"));
const roots = Object.keys(selectCliRuntimeExternalDependencies(serverPackage.dependencies ?? {}));

/** Node's lookup from a package's real directory: the nearest node_modules/<name> upwards. */
function findPackageDir(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = NodePath.join(dir, "node_modules", name);
    if (NodeFS.existsSync(NodePath.join(candidate, "package.json"))) {
      return NodeFS.realpathSync(candidate);
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function copyPackage(source, destination) {
  NodeFS.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    // Dependencies are placed by this script, never copied from inside a package.
    filter: (file) => !NodePath.relative(source, file).split(NodePath.sep).includes("node_modules"),
  });
}

NodeFS.mkdirSync(target, { recursive: true });
const topLevel = new Map(); // name -> real source dir placed at target/<name>
const placed = new Set(); // `${realDir}|${destination}`
const missingRoots = roots.filter((name) => findPackageDir(serverDir, name) === null);
const queue = roots.map((name) => ({ name, fromDir: serverDir, parentDest: null }));

while (queue.length > 0) {
  const { name, fromDir, parentDest } = queue.shift();
  const realDir = findPackageDir(fromDir, name);
  // Roots were checked above; a missing optional dependency is another
  // platform's binary, and a missing regular one would fail at require time
  // exactly as it does from the checkout.
  if (realDir === null) continue;
  let destination;
  const existing = topLevel.get(name);
  if (existing === undefined) {
    destination = NodePath.join(target, name);
    topLevel.set(name, realDir);
  } else if (existing === realDir) {
    destination = NodePath.join(target, name);
  } else {
    // A second version: nest it under the package that needs it.
    destination = NodePath.join(parentDest ?? target, "node_modules", name);
  }
  const key = `${realDir}|${destination}`;
  if (placed.has(key)) continue;
  placed.add(key);
  if (!NodeFS.existsSync(destination)) copyPackage(realDir, destination);

  const manifest = readJson(NodePath.join(realDir, "package.json"));
  for (const dep of [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]) {
    queue.push({ name: dep, fromDir: realDir, parentDest: destination });
  }
}

// node-pty ships every platform's prebuilds (~58 MB); only this one loads.
const prebuilds = NodePath.join(target, "node-pty", "prebuilds");
if (NodeFS.existsSync(prebuilds)) {
  // A plain build script, not Effect code: the host platform is the answer.
  // oxlint-disable-next-line t3code/no-global-process-runtime
  const keep = `${NodeOS.platform()}-${NodeOS.arch()}`;
  for (const entry of NodeFS.readdirSync(prebuilds)) {
    if (entry !== keep) {
      NodeFS.rmSync(NodePath.join(prebuilds, entry), { recursive: true, force: true });
    }
  }
}

function sizeOf(dir) {
  let total = 0;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const file = NodePath.join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(file) : NodeFS.statSync(file).size;
  }
  return total;
}

console.log(
  JSON.stringify({
    roots,
    missingRoots,
    packages: placed.size,
    megabytes: Math.round(sizeOf(target) / 1e5) / 10,
  }),
);
if (missingRoots.length > 0) process.exit(1);
