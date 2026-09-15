// Deterministic Migrations.ts resolution for the weekly upstream sync.
//
// Run from the repo root in the middle of `git merge --no-commit upstream/main`.
// Takes OUR Migrations.ts (HEAD) and appends every migration upstream added
// since the merge-base at our next free id, keeping upstream's file name and
// importing it as MigrationUpstreamNNNN. Records each renumbering in
// apps/server/src/persistence/upstreamMigrationIds.ts and stages both files.
// The migrator only runs ids above the latest applied one, so an upstream
// migration left at its upstream number would be skipped on the live DB.
//
// Exit codes: 0 resolved (or nothing to do), 1 error, 2 needs a human:
//   - upstream modified, renamed or deleted an existing migration file;
//   - a new upstream migration is non-additive (DROP / RENAME / DELETE FROM),
//     which would make a binary-only rollback unsafe.
// Prints one JSON line with the outcome.
//
// Usage: node scripts/personal/sync/resolve-migrations.ts [--base <sha>] [--upstream <ref>]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const MIGRATIONS_TS = "apps/server/src/persistence/Migrations.ts";
const MIGRATIONS_DIR = "apps/server/src/persistence/Migrations/";
const MAP_TS = "apps/server/src/persistence/upstreamMigrationIds.ts";

function git(...args: string[]): string {
  return NodeChildProcess.execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function finish(code: number, outcome: Record<string, unknown>): never {
  console.log(JSON.stringify(outcome));
  process.exit(code);
}

const upstream = arg("--upstream") ?? "MERGE_HEAD";
const base = arg("--base") ?? git("merge-base", "HEAD", upstream);

const changes = git("diff", "--name-status", "--no-renames", base, upstream, "--", MIGRATIONS_DIR)
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => {
    const [status, path] = line.split("\t");
    return { status: status!, path: path! };
  })
  .filter(({ path }) => /\/\d{3}_\w+\.ts$/.test(path) && !path.endsWith(".test.ts"));

const modified = changes.filter(({ status }) => status !== "A").map(({ path }) => path);
if (modified.length > 0) {
  finish(2, {
    status: "needs_judgment",
    reason: "upstream modified or removed existing migration files",
    files: modified,
  });
}

const added = changes
  .filter(({ status }) => status === "A")
  .map(({ path }) => path.slice(MIGRATIONS_DIR.length, -".ts".length))
  .toSorted();

const nonAdditive = added.filter((file) =>
  /\b(DROP|RENAME|DELETE\s+FROM)\b/i.test(git("show", `${upstream}:${MIGRATIONS_DIR}${file}.ts`)),
);
if (nonAdditive.length > 0) {
  finish(2, {
    status: "needs_judgment",
    reason: "non-additive upstream migration (DROP/RENAME/DELETE FROM): no auto-deploy",
    files: nonAdditive,
  });
}

let mapSource = NodeFS.readFileSync(MAP_TS, "utf8");
const mapped = new Map(
  [...mapSource.matchAll(/"(\d{3}_\w+)":\s*(\d+)/g)].map((match) => [match[1]!, Number(match[2])]),
);

// Ours: HEAD's registry, never the conflicted working copy.
let registry = git("show", `HEAD:${MIGRATIONS_TS}`) + "\n";
const entryPattern = /^\s*\[(\d+), "[^"]+", \w+\],$/gm;
const ids = [...registry.matchAll(entryPattern)].map((match) => Number(match[1]));
if (ids.length === 0) finish(1, { status: "error", reason: "no migration entries found in HEAD" });
let nextId = Math.max(...ids) + 1;

const appended: Array<{ file: string; id: number }> = [];
for (const file of added) {
  if (mapped.has(file)) {
    // Already renumbered by an earlier sync; HEAD must register it.
    if (!registry.includes(`"./Migrations/${file}.ts"`)) {
      finish(1, { status: "error", reason: `${file} is mapped but not registered in HEAD` });
    }
    continue;
  }
  const alias = `MigrationUpstream${file.slice(0, 3).padStart(4, "0")}`;
  const name = file.slice(4);
  const id = nextId++;
  const imports = [...registry.matchAll(/^import Migration\w+ from "\.\/Migrations\/[^"]+";$/gm)];
  const lastImport = imports.at(-1)!;
  const importEnd = lastImport.index! + lastImport[0].length;
  registry = `${registry.slice(0, importEnd)}\nimport ${alias} from "./Migrations/${file}.ts";${registry.slice(importEnd)}`;
  const entries = [...registry.matchAll(entryPattern)];
  const lastEntry = entries.at(-1)!;
  const entryEnd = lastEntry.index! + lastEntry[0].length;
  registry = `${registry.slice(0, entryEnd)}\n  // Upstream ${file}, renumbered (see upstreamMigrationIds.ts).\n  [${id}, "${name}", ${alias}],${registry.slice(entryEnd)}`;
  mapSource = mapSource.replace(/\n};\s*$/, `\n  "${file}": ${id},\n};\n`);
  appended.push({ file, id });
}

if (
  appended.length === 0 &&
  !git("diff", "--name-only", "--diff-filter=U").split("\n").includes(MIGRATIONS_TS)
) {
  finish(0, { status: "resolved", appended, note: "no new upstream migrations" });
}

NodeFS.writeFileSync(MIGRATIONS_TS, registry.replace(/\n+$/, "\n"));
NodeFS.writeFileSync(MAP_TS, mapSource);
git("add", MIGRATIONS_TS, MAP_TS);
finish(0, { status: "resolved", appended, maxId: nextId - 1 });
