// Golden check for B1 and after: the personal contract may gain paths (U's
// shared schemas enter every personal method) but may not lose or change one.
//
//   node scripts/personal/sync/golden-check.mjs --golden <old.json> --live <new.json>
//
// server.getConfig and server.refreshProviders are upstream-owned snapshots in
// the golden. Their removed fields are ledger rows (C9, D1), not a personal
// contract loss, so they are the only default allowlist. Everything else in
// the golden is personal-owned.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const UPSTREAM_OWNED_TAGS = ["server.getConfig", "server.refreshProviders"];

const walk = (before, after, path, rows) => {
  if (isObject(before) && isObject(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (!(key in before)) {
        rows.push({ kind: "added", path: `${path}/${key}` });
      } else if (!(key in after)) {
        rows.push({ kind: "missing", path: `${path}/${key}` });
      } else {
        walk(before[key], after[key], `${path}/${key}`, rows);
      }
    }
    return;
  }
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.every((item) => typeof item === "string") &&
    after.every((item) => typeof item === "string")
  ) {
    const removed = before.filter((item) => !after.includes(item));
    if (removed.length > 0) {
      rows.push({ kind: "enum", path, removed });
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (let index = 0; index < before.length; index += 1) {
      walk(before[index], after[index], `${path}/${index}`, rows);
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    rows.push({ kind: "changed", path });
  }
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const entriesByTag = (document) =>
  new Map(
    (Array.isArray(document?.entries) ? document.entries : []).map((entry) => [entry.tag, entry]),
  );

/** Every added, missing, changed or value-removing enum row between two goldens. */
export const diffGoldens = (before, after) => {
  const beforeTags = entriesByTag(before);
  const afterTags = entriesByTag(after);
  const rows = [];
  for (const tag of [...new Set([...beforeTags.keys(), ...afterTags.keys()])].sort()) {
    if (!beforeTags.has(tag)) {
      rows.push({ kind: "added-method", path: tag });
      continue;
    }
    if (!afterTags.has(tag)) {
      rows.push({ kind: "missing-method", path: tag });
      continue;
    }
    walk(beforeTags.get(tag), afterTags.get(tag), tag, rows);
  }
  return rows;
};

const tagOf = (path) => path.split("/")[0];

/** Rows that break the rule: a removed or changed path outside the allowlist. */
export const violations = (rows, allowedTags = UPSTREAM_OWNED_TAGS) => {
  const allowed = new Set(allowedTags);
  return rows.filter((row) => {
    if (row.kind === "added" || row.kind === "added-method") return false;
    return !allowed.has(tagOf(row.path));
  });
};

const parseArgs = (argv) => {
  const options = { golden: null, live: null, allow: [...UPSTREAM_OWNED_TAGS] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--golden" || arg === "--live" || arg === "--allow") {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--allow") options.allow.push(next);
      else options[arg.slice(2)] = NodePath.resolve(next);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
};

const usage =
  "Usage: node scripts/personal/sync/golden-check.mjs --golden <old.json> --live <new.json> [--allow <tag>]";

const main = () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`golden-check: ${error.message}\n\n${usage}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(usage);
    return;
  }
  if (options.golden === null || options.live === null) {
    console.error(`golden-check: --golden and --live are required\n\n${usage}`);
    process.exit(2);
  }

  let rows;
  try {
    rows = diffGoldens(
      JSON.parse(NodeFS.readFileSync(options.golden, "utf8")),
      JSON.parse(NodeFS.readFileSync(options.live, "utf8")),
    );
  } catch (error) {
    console.error(`golden-check: ${error.message}`);
    process.exit(2);
  }

  const failures = violations(rows, options.allow);
  const counts = rows.reduce((byKind, row) => {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    return byKind;
  }, {});
  console.log(
    `golden-check: ${rows.length} rows (${
      Object.entries(counts)
        .map(([kind, count]) => `${kind} ${count}`)
        .join(", ") || "none"
    })`,
  );
  for (const row of failures) {
    console.error(`  ${row.kind} ${row.path}${row.removed ? ` -${row.removed.join(",")}` : ""}`);
  }
  console.log(
    `  removed or changed paths: ${failures.length} (allowed tags ${options.allow.join(", ")})`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${NodePath.resolve(process.argv[1])}`).href
) {
  main();
}
