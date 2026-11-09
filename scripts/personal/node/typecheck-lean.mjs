#!/usr/bin/env node
// Usage, from a package dir (apps/server, apps/web): node ../../scripts/personal/node/typecheck-lean.mjs
// Kill switch: HBOTS_TYPECHECK=full runs the old single `tsc --noEmit`.
import * as NodePath from "node:path";
import { resolveCatalogTsc, runTypecheck } from "./lib/typecheck.mjs";

const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..", "..");
try {
  process.exitCode = runTypecheck({
    cwd: process.cwd(),
    tsc: resolveCatalogTsc({ repoRoot }),
  });
} catch (error) {
  process.stderr.write(`typecheck: ${error.message}\n`);
  process.exitCode = 2;
}
