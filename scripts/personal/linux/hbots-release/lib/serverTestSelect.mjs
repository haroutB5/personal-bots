// Static import-graph selection for the server-tests gate, plus the repo readers
// it runs on. A test is selected when its imports reach a changed file, when it
// names a changed file's parent/basename literally, or when it sits under a
// changed fixtures folder. Pure over the reader, so the collector and the seal
// resolve the same files from the working tree or from a release commit.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

export const SERVER_PKG_DIR = "apps/server";
export const SERVER_GATE_DIRS = [
  "src/personal",
  "src/mcp",
  "src/persistence",
  "src/preview",
  "src/workspace",
  "src/assets",
  "src/orchestration-v2",
  "src/cloud",
  "src/provider",
  "src/process",
];
// Run with every server-tests invocation; the gate command names them, so the
// plan's selected args stay the import-graph result alone.
export const SERVER_ALWAYS = [
  "src/persistence/Migrations.registry.test.ts",
  "src/provider/AgentContextBudget.test.ts",
  "src/personal/agentContextBudget.test.ts",
  "src/personal/personalContextBudget.test.ts",
  "src/personal/botInstructionCoverage.test.ts",
];

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/;
const isTest = (file) => /\.test\.tsx?$/.test(file);

/** Reader over a checkout. */
export function fsReader(root) {
  const listFiles = (dir) => {
    const out = [];
    const walk = (rel) => {
      let entries;
      try {
        entries = NodeFS.readdirSync(NodePath.join(root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const next = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(next);
        else if (entry.isFile()) out.push(next);
      }
    };
    walk(dir);
    return out;
  };
  return {
    listFiles,
    exists: (file) => {
      try {
        return NodeFS.statSync(NodePath.join(root, file)).isFile();
      } catch {
        return false;
      }
    },
    read: (file) => {
      try {
        return NodeFS.readFileSync(NodePath.join(root, file), "utf8");
      } catch {
        return null;
      }
    },
    prefetch: () => {},
  };
}

/**
 * Reader over one commit, through git cat-file --batch. Listing names the
 * universe first, then one batch call loads every source the selector may read,
 * so the walk costs one subprocess whatever the checkout says.
 */
export function gitReader(repo, sha) {
  const listings = new Map();
  const cache = new Map();
  // One listing of the whole commit, so a file outside the listed folders (an
  // import that reaches into apps/hbots-mobile) resolves the way it does on disk.
  let tree = null;
  const allFiles = () => {
    tree ??= new Set(
      NodeChildProcess.execFileSync(
        "git",
        ["-C", repo, "ls-tree", "-r", "--name-only", "-z", sha],
        { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
      )
        .split("\0")
        .filter(Boolean),
    );
    return tree;
  };
  const listFiles = (dir) => {
    if (listings.has(dir)) return listings.get(dir);
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const out = [...allFiles()].filter((file) => file.startsWith(prefix) || file === dir);
    listings.set(dir, out);
    return out;
  };
  const prefetch = (files) => {
    const missing = [...new Set(files)].filter((file) => !cache.has(file));
    if (missing.length === 0) return;
    const result = NodeChildProcess.spawnSync("git", ["-C", repo, "cat-file", "--batch"], {
      input: `${missing.map((file) => `${sha}:${file}`).join("\n")}\n`,
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`git cat-file --batch failed: ${result.stderr}`);
    // The header size is bytes, so parse the buffer by bytes and decode each blob.
    const out = result.stdout;
    let at = 0;
    let index = 0;
    const newlineAt = (from) => out.indexOf(0x0a, from);
    while (at < out.length && index < missing.length) {
      const newline = newlineAt(at);
      if (newline === -1) break;
      const header = out.subarray(at, newline).toString("utf8");
      at = newline + 1;
      const match = /^[0-9a-f]+ \S+ (\d+)$/.exec(header);
      if (!match) {
        cache.set(missing[index++], null);
        continue;
      }
      const size = Number(match[1]);
      cache.set(missing[index++], out.subarray(at, at + size).toString("utf8"));
      at += size + 1;
    }
    for (; index < missing.length; index++) cache.set(missing[index], null);
  };
  return {
    listFiles,
    exists: (file) => allFiles().has(file),
    read: (file) => {
      if (!cache.has(file)) prefetch([file]);
      return cache.get(file) ?? null;
    },
    prefetch,
  };
}

const extensionCandidates = (file) => {
  const base = file.replace(/\.(?:js|mjs|cjs)$/, "");
  return [
    file,
    ...[".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"].map((ext) => base + ext),
    ...[".ts", ".tsx", "/index.ts", "/index.tsx", "/index.js"].map((ext) => file + ext),
  ];
};

function makeResolver(reader, packages) {
  const tryFile = (file) => {
    for (const candidate of extensionCandidates(file)) {
      if (reader.exists(candidate)) return candidate;
    }
    return null;
  };
  const resolveSpec = (spec, from) => {
    const clean = spec.split("?")[0];
    if (clean.startsWith("."))
      return tryFile(
        NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(from), clean)),
      );
    const match = /^(@[^/]+\/[^/]+|[^@/][^/]*)(\/.*)?$/.exec(clean);
    if (!match || !packages.has(match[1])) return null;
    const { dir, exports } = packages.get(match[1]);
    const key = "." + (match[2] ?? "");
    let target = exports[key];
    if (!target) {
      for (const [name, value] of Object.entries(exports)) {
        if (name.endsWith("/*") && key.startsWith(name.slice(0, -1))) {
          const mapped =
            typeof value === "string" ? value : (value.import ?? value.default ?? value.types);
          target = mapped?.replace("*", key.slice(name.length - 1));
        }
      }
    }
    if (target && typeof target === "object")
      target = target.import ?? target.default ?? target.types;
    return typeof target === "string" ? tryFile(NodePath.posix.join(dir, target)) : null;
  };
  return { tryFile, resolveSpec };
}

const IMPORT_RE =
  /(?:import|export)\s+(type\s+)?(\{[^}]*\}|[^;'"]*?)\s*from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|vi\.mock\(\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

export function selectServerTests({ reader, changedPaths }) {
  const tests = SERVER_GATE_DIRS.flatMap((dir) =>
    reader.listFiles(`${SERVER_PKG_DIR}/${dir}`),
  ).filter(isTest);
  const packageFiles = reader.listFiles("packages");
  const packages = new Map();
  for (const file of packageFiles) {
    if (!/^packages\/[^/]+\/package\.json$/.test(file)) continue;
    try {
      const manifest = JSON.parse(reader.read(file));
      packages.set(manifest.name, {
        dir: NodePath.posix.dirname(file),
        exports: manifest.exports ?? {},
      });
    } catch {}
  }
  reader.prefetch?.(
    [...reader.listFiles(SERVER_PKG_DIR), ...packageFiles].filter((file) => TEXT.test(file)),
  );
  const { resolveSpec } = makeResolver(reader, packages);
  const isBarrel = (file) => {
    const source = reader.read(file)?.replace(/\/\/.*$/gm, "");
    if (!source) return false;
    return (
      /export\s/.test(source) &&
      source.replace(/export\s+(type\s+)?(\*|\{[^}]*\})\s*from\s*["'][^"']+["'];?/g, "").trim() ===
        ""
    );
  };
  const ownNames = (file) => {
    const source = reader.read(file) ?? "";
    const out = new Set();
    for (const match of source.matchAll(
      /export\s+(?:declare\s+)?(?:const|let|var|function\*?|class|type|interface|enum|namespace)\s+([A-Za-z0-9_$]+)/g,
    ))
      out.add(match[1]);
    for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g))
      for (const name of match[1].split(",")) {
        const exported = name
          .trim()
          .split(/\s+as\s+/)
          .pop();
        if (exported) out.add(exported.replace(/^type\s+/, ""));
      }
    return out;
  };
  const barrelMaps = new Map();
  const barrelMap = (file) => {
    if (barrelMaps.has(file)) return barrelMaps.get(file);
    const map = new Map();
    barrelMaps.set(file, map);
    const source = reader.read(file) ?? "";
    for (const match of source.matchAll(
      /export\s+(?:type\s+)?(\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g,
    )) {
      const target = resolveSpec(match[2], file);
      if (!target) continue;
      if (match[1] === "*") {
        const names = isBarrel(target) ? barrelMap(target) : null;
        if (names) for (const [name, from] of names) map.set(name, from);
        else for (const name of ownNames(target)) map.set(name, target);
      } else {
        for (const spec of match[1].slice(1, -1).split(",")) {
          const parts = spec
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/);
          if (parts[0]) map.set(parts.pop(), target);
        }
      }
    }
    return map;
  };
  const deps = new Map();
  const depsOf = (file) => {
    if (deps.has(file)) return deps.get(file);
    const out = new Set();
    deps.set(file, out);
    if (!SOURCE.test(file)) return out;
    const source = reader.read(file);
    if (!source) return out;
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[3] ?? match[4] ?? match[5] ?? match[6] ?? match[7];
      const target = resolveSpec(spec, file);
      if (!target) continue;
      if (match[2]?.startsWith("{") && isBarrel(target)) {
        const map = barrelMap(target);
        let unresolved = false;
        for (const item of match[2].slice(1, -1).split(",")) {
          const name = item
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0];
          if (!name) continue;
          const from = map.get(name);
          if (from) out.add(from);
          else unresolved = true;
        }
        if (unresolved) out.add(target);
      } else {
        out.add(target);
      }
    }
    return out;
  };

  const reverse = new Map();
  const seen = new Set(tests);
  const queue = [...tests];
  while (queue.length) {
    const file = queue.pop();
    for (const dependency of depsOf(file)) {
      if (!reverse.has(dependency)) reverse.set(dependency, new Set());
      reverse.get(dependency).add(file);
      if (!seen.has(dependency)) {
        seen.add(dependency);
        queue.push(dependency);
      }
    }
  }
  const graphModules = new Set(seen);

  // Any changed file the graph reaches counts, wherever it lives: a server test can
  // import or mock a file under apps/hbots-mobile.
  const changed = new Set(
    changedPaths.filter(
      (file) =>
        file.startsWith(`${SERVER_PKG_DIR}/`) ||
        file.startsWith("packages/") ||
        graphModules.has(file),
    ),
  );
  const selected = new Set();
  // A test the release changed or added runs itself. A file deleted at the head is
  // not in `tests`, so no arg names a path that matches nothing.
  const testSet = new Set(tests);
  for (const file of changedPaths) if (testSet.has(file)) selected.add(file);

  // Literal references. A test or module can read a file by its path string, which
  // no import shows: a fixture, a doc, a spawned entry file. Every changed file
  // outside the graph gets needles, whatever its extension, and a test that holds
  // one is selected. A graph module that holds one counts as changed too, so the
  // tests that import it are selected by the walk below.
  const parentOf = (file) => NodePath.posix.basename(NodePath.posix.dirname(file));
  const needles = new Set();
  for (const file of changedPaths.filter((entry) => !graphModules.has(entry))) {
    const base = NodePath.posix.basename(file);
    needles.add(`${parentOf(file)}/${base}`);
    const dir = NodePath.posix.dirname(file);
    // Outside the server and the packages, a path string may name the folder.
    if (
      !file.startsWith(`${SERVER_PKG_DIR}/`) &&
      !file.startsWith("packages/") &&
      dir.split("/").length >= 3
    )
      needles.add(dir);
    // A spawned entry file is named relative to the test, as "../bin.ts".
    if (file.startsWith(`${SERVER_PKG_DIR}/`) && !/^index\./.test(base)) needles.add(`/${base}`);
  }
  if (needles.size) {
    for (const test of tests) {
      const source = reader.read(test);
      if (!source) continue;
      for (const needle of needles) if (source.includes(needle)) selected.add(test);
    }
    for (const file of graphModules) {
      if (isTest(file)) continue;
      const source = reader.read(file);
      if (!source) continue;
      for (const needle of needles) if (source.includes(needle)) changed.add(file);
    }
  }

  const reached = new Set();
  let frontier = [...changed];
  while (frontier.length) {
    const next = [];
    for (const file of frontier) {
      if (reached.has(file)) continue;
      reached.add(file);
      for (const importer of reverse.get(file) ?? []) {
        if (isTest(importer)) selected.add(importer);
        else next.push(importer);
      }
    }
    frontier = next;
  }

  const fixtureParents = new Set();
  for (const file of changedPaths) {
    const match = /^(.*)\/(?:testFixtures|fixtures)\//.exec(file);
    if (match) fixtureParents.add(match[1]);
  }
  if (fixtureParents.size) {
    for (const test of tests)
      for (const parent of fixtureParents) if (test.startsWith(`${parent}/`)) selected.add(test);
  }
  const relative = (file) => file.slice(SERVER_PKG_DIR.length + 1);
  return [...selected].map(relative).sort();
}
