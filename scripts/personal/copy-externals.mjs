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
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

const [serverDirArg, targetArg] = process.argv.slice(2);
if (!serverDirArg || !targetArg) {
  console.error("usage: node copy-externals.mjs <apps/server dir> <target node_modules dir>");
  process.exit(2);
}
const serverDir = NodeFs.realpathSync(serverDirArg);
const target = NodePath.resolve(targetArg);
const repoRoot = NodePath.resolve(serverDir, "..", "..");
const { selectCliRuntimeExternalDependencies } = await import(
  pathToFileURL(NodePath.join(repoRoot, "scripts", "lib", "cli-external-packages.ts")).href
);

const readJson = (file) => JSON.parse(NodeFs.readFileSync(file, "utf8"));
const serverPackage = readJson(NodePath.join(serverDir, "package.json"));
const roots = Object.keys(selectCliRuntimeExternalDependencies(serverPackage.dependencies ?? {}));

/** Node's lookup from a package's real directory: the nearest node_modules/<name> upwards. */
function findPackageDir(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = NodePath.join(dir, "node_modules", name);
    if (NodeFs.existsSync(NodePath.join(candidate, "package.json"))) {
      return NodeFs.realpathSync(candidate);
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function copyPackage(source, destination) {
  NodeFs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    // Dependencies are placed by this script, never copied from inside a package.
    filter: (file) => !NodePath.relative(source, file).split(NodePath.sep).includes("node_modules"),
  });
}

NodeFs.mkdirSync(target, { recursive: true });
const topLevel = new Map(); // name -> real source dir placed at target/<name>
const placed = new Set(); // `${realDir}|${destination}`
let bytes = 0;
const missingRoots = [];
const queue = roots.map((name) => ({
  name,
  fromDir: serverDir,
  parentDest: null,
  optional: false,
}));
for (const name of roots) {
  if (findPackageDir(serverDir, name) === null) missingRoots.push(name);
}

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
  if (!NodeFs.existsSync(destination)) copyPackage(realDir, destination);

  const manifest = readJson(NodePath.join(realDir, "package.json"));
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    queue.push({ name: dep, fromDir: realDir, parentDest: destination, optional: false });
  }
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
    queue.push({ name: dep, fromDir: realDir, parentDest: destination, optional: true });
  }
}

// node-pty ships every platform's prebuilds (~58 MB); only this one loads.
const prebuilds = NodePath.join(target, "node-pty", "prebuilds");
if (NodeFs.existsSync(prebuilds)) {
  const keep = `${process.platform}-${process.arch}`;
  for (const entry of NodeFs.readdirSync(prebuilds)) {
    if (entry !== keep)
      NodeFs.rmSync(NodePath.join(prebuilds, entry), { recursive: true, force: true });
  }
}

function sizeOf(dir) {
  let total = 0;
  for (const entry of NodeFs.readdirSync(dir, { withFileTypes: true })) {
    const file = NodePath.join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(file) : NodeFs.statSync(file).size;
  }
  return total;
}
bytes = sizeOf(target);

console.log(
  JSON.stringify({
    roots,
    missingRoots,
    packages: placed.size,
    megabytes: Math.round(bytes / 1e5) / 10,
  }),
);
if (missingRoots.length > 0) process.exit(1);
