// @effect-diagnostics nodeBuiltinImport:off - Local release check, runs on the build machine.
import * as NodeFS from "node:fs";

import { duplicatePackages } from "./bundleDuplicates.ts";

const file = process.argv[2];
if (file === undefined) {
  console.error("Usage: node check-bundle-duplicates.ts <metro-source-map>");
  process.exit(2);
}

const map = JSON.parse(NodeFS.readFileSync(file, "utf8")) as { sources?: unknown };
if (!Array.isArray(map.sources) || !map.sources.every((source) => typeof source === "string")) {
  console.error(`FAIL ${file} has no Metro sources array`);
  process.exit(2);
}

const duplicates = duplicatePackages(map.sources);
for (const duplicate of duplicates) {
  console.log(`FAIL ${duplicate.name} is bundled from ${String(duplicate.roots.length)} roots`);
  for (const root of duplicate.roots) {
    console.log(`       ${String(root.files)} files ${root.root}`);
  }
}
console.log(
  duplicates.length === 0
    ? `ok   ${String(map.sources.length)} modules, every package from one root`
    : `${String(duplicates.length)} duplicated package(s)`,
);
process.exit(duplicates.length === 0 ? 0 : 1);
