#!/usr/bin/env node
// Usage, from a package dir (apps/server, apps/web): node ../../scripts/personal/node/typecheck-lean.mjs
// Kill switch: HBOTS_TYPECHECK=full runs the old single `tsc --noEmit`.
import path from "node:path";
import { runTypecheck } from "./lib/typecheck.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
try {
  process.exitCode = runTypecheck({
    cwd: process.cwd(),
    tsc: path.join(repoRoot, "node_modules", ".bin", "tsc"),
  });
} catch (error) {
  process.stderr.write(`typecheck: ${error.message}\n`);
  process.exitCode = 2;
}
