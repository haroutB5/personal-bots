// The personal RPC contract golden.
//
//   node scripts/personal/contract/snapshot-personal-contract.ts           # write the golden
//   node scripts/personal/contract/snapshot-personal-contract.ts --check   # fail on any drift
//
// Exit codes: 0 no drift (or written), 1 drift, 2 bad golden or usage.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  buildPersonalContractSnapshot,
  diffPersonalContract,
  parsePersonalContract,
  serializePersonalContract,
} from "../../../packages/contracts/src/personalContractSnapshot.ts";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const DEFAULT_GOLDEN_PATH = NodePath.join(HERE, "personal-contract.golden.json");

const usage = `Usage: node scripts/personal/contract/snapshot-personal-contract.ts [--check] [--out <path>]

  --check      compare the live contract with the golden and exit 1 on drift
  --out <path> golden path (default ${DEFAULT_GOLDEN_PATH})`;

const parseArgs = (argv: ReadonlyArray<string>): { check: boolean; out: string } => {
  let check = false;
  let out = DEFAULT_GOLDEN_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--out") {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error("--out needs a path");
      }
      out = NodePath.resolve(next);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { check, out };
};

const formatDiffValue = (value: unknown): string => {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > 240 ? `${text.slice(0, 240)}...` : text;
};

const main = (): void => {
  let options: { check: boolean; out: string };
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage}`);
    process.exit(2);
  }

  const live = buildPersonalContractSnapshot();
  if (!options.check) {
    NodeFS.mkdirSync(NodePath.dirname(options.out), { recursive: true });
    NodeFS.writeFileSync(options.out, serializePersonalContract(live));
    console.log(`wrote ${options.out} (${live.entries.length} methods)`);
    return;
  }

  let goldenText: string;
  try {
    goldenText = NodeFS.readFileSync(options.out, "utf8");
  } catch {
    console.error(`personal contract golden is missing: ${options.out}`);
    console.error("Generate it with: node scripts/personal/contract/snapshot-personal-contract.ts");
    process.exit(2);
  }

  let golden: ReturnType<typeof parsePersonalContract>;
  try {
    golden = parsePersonalContract(JSON.parse(goldenText));
  } catch (error) {
    console.error(`${options.out}: ${(error as Error).message}`);
    process.exit(2);
  }

  const diffs = diffPersonalContract(golden, live);
  if (diffs.length === 0) {
    console.log(`personal contract golden matches (${live.entries.length} methods)`);
    return;
  }

  console.error(
    `personal contract drift: ${diffs.length}${diffs.length >= 100 ? "+" : ""} difference(s) in ${options.out}`,
  );
  for (const diff of diffs) {
    console.error(`  ${diff.kind}: ${diff.path}`);
    if (diff.kind !== "added") {
      console.error(`    golden: ${formatDiffValue(diff.expected)}`);
    }
    if (diff.kind !== "missing") {
      console.error(`    live:   ${formatDiffValue(diff.actual)}`);
    }
  }
  console.error("If the change is intended, regenerate and review the golden diff.");
  process.exit(1);
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  main();
}
