// @effect-diagnostics nodeBuiltinImport:off - Local release check, runs on the build machine.
import * as NodeFS from "node:fs";

import { scanBundle } from "./bundleScan.ts";

const file = process.argv[2];
if (file === undefined) {
  console.error("Usage: node scan-bundle.ts <bundle-or-hbc-file>");
  process.exit(2);
}

const findings = scanBundle(NodeFS.readFileSync(file).toString("latin1"));
for (const finding of findings) {
  console.log(`FAIL ${finding.ruleId}: ${finding.match} … ${finding.context}`);
}
console.log(
  findings.length === 0
    ? "ok   no forbidden strings"
    : `${String(findings.length)} forbidden hit(s)`,
);
process.exit(findings.length === 0 ? 0 : 1);
