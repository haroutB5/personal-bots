// The proposal ledger CLI for the nightly Claude Code update run.
//
// The Updates bot records its decisions with it, the ship pipeline
// (nightly.ps1 / nightly-pipeline.ps1) reverts, ships and renders the morning
// report with it, and "approve P<n>" in chat goes through it. The logic lives
// in apps/server/src/personal/claudeCodeReview/proposalLedger.ts (tested
// there); this file only parses arguments and reads/writes the JSON file.
//
//   node scripts/personal/updates/ledger.ts [--ledger <file>] [--run <id>] <command> ...
//
//   list [--json]                                  every proposal and its status
//   actionable                                     open + approved ids (one line)
//   add --source <label> --title <text> [--detail <text>]      prints the new id
//   decide <id> --rating safe|risky --reason <text>
//   applied <id> --commits <sha[,sha]> [--notes <text>]
//   failed <id> --reason <text>
//   approve <id> [<id> ...]        queued for the next 04:00 run
//   reject <id> [<id> ...]
//   run-commits                    JSON: what --run applied, with commits
//   run-reverted --reason <text>   everything --run applied waits for approval
//   run-shipped --version <x.y.z>
//   report --outcome <file>        prints the morning report (Markdown)
//
// Default ledger: C:/Claude/AI/personal-bots-notes/claude-code-updates/proposals.json
// (PB_NOTES_DIR overrides the notes folder).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  actionableProposals,
  addProposal,
  appliedInRun,
  approveProposal,
  decideProposal,
  LedgerError,
  markApplied,
  markFailed,
  markRunReverted,
  markRunShipped,
  parseLedger,
  rejectProposal,
  renderMorningReport,
  serializeLedger,
  type ProposalLedger,
  type RunOutcome,
} from "../../../apps/server/src/personal/claudeCodeReview/proposalLedger.ts";

const notesDir = process.env.PB_NOTES_DIR ?? "C:/Claude/AI/personal-bots-notes";
const DEFAULT_LEDGER = `${notesDir}/claude-code-updates/proposals.json`;

interface Parsed {
  readonly positional: Array<string>;
  readonly flags: Map<string, string>;
  readonly switches: Set<string>;
}

function parseArgs(argv: ReadonlyArray<string>): Parsed {
  const positional: Array<string> = [];
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  const valued = new Set([
    "ledger",
    "run",
    "source",
    "title",
    "detail",
    "rating",
    "reason",
    "commits",
    "notes",
    "version",
    "outcome",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (valued.has(name)) {
        const value = argv[index + 1];
        if (value === undefined) throw new LedgerError(`--${name} needs a value.`);
        flags.set(name, value);
        index++;
      } else {
        switches.add(name);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, switches };
}

const need = (parsed: Parsed, name: string): string => {
  const value = parsed.flags.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw new LedgerError(`--${name} is required.`);
  }
  return value;
};

function readLedger(file: string): ProposalLedger {
  return parseLedger(NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null);
}

/** Write to a temp file beside it, then rename: a crash never leaves half a ledger. */
function writeLedger(file: string, ledger: ProposalLedger): void {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, serializeLedger(ledger), "utf8");
  NodeFS.renameSync(temp, file);
}

function main(argv: ReadonlyArray<string>): number {
  const parsed = parseArgs(argv);
  const file = parsed.flags.get("ledger") ?? DEFAULT_LEDGER;
  const runId = parsed.flags.get("run") ?? null;
  const [command, ...rest] = parsed.positional;
  const now = new Date().toISOString();
  const ledger = readLedger(file);
  const needRun = () => {
    if (runId === null) throw new LedgerError("--run is required for this command.");
    return runId;
  };
  switch (command) {
    case "list": {
      if (parsed.switches.has("json")) {
        process.stdout.write(serializeLedger(ledger));
        return 0;
      }
      for (const entry of ledger.proposals) {
        const extra = [entry.rating, entry.version, entry.reason].filter(Boolean).join(" | ");
        console.log(`${entry.id}\t${entry.status}\t${entry.title}${extra ? `\t(${extra})` : ""}`);
      }
      return 0;
    }
    case "actionable":
      console.log(
        actionableProposals(ledger)
          .map((entry) => entry.id)
          .join(" "),
      );
      return 0;
    case "add": {
      const detail = parsed.flags.get("detail");
      const result = addProposal(
        ledger,
        {
          title: need(parsed, "title"),
          source: need(parsed, "source"),
          ...(detail === undefined ? {} : { detail }),
        },
        now,
        runId,
      );
      writeLedger(file, result.ledger);
      console.log(result.id);
      return 0;
    }
    case "decide": {
      const rating = need(parsed, "rating");
      if (rating !== "safe" && rating !== "risky") {
        throw new LedgerError("--rating is safe or risky.");
      }
      const id = rest[0] ?? "";
      writeLedger(file, decideProposal(ledger, id, rating, need(parsed, "reason"), now, runId));
      console.log(`${id} rated ${rating}`);
      return 0;
    }
    case "applied": {
      const id = rest[0] ?? "";
      const commits = need(parsed, "commits").split(/[,\s]+/);
      writeLedger(
        file,
        markApplied(ledger, id, commits, parsed.flags.get("notes") ?? "", now, runId),
      );
      console.log(`${id} applied`);
      return 0;
    }
    case "failed": {
      const id = rest[0] ?? "";
      writeLedger(file, markFailed(ledger, id, need(parsed, "reason"), now, runId));
      console.log(`${id} waits for approval`);
      return 0;
    }
    case "approve":
    case "reject": {
      if (rest.length === 0) throw new LedgerError(`${command} needs at least one id.`);
      let next = ledger;
      for (const id of rest) {
        next =
          command === "approve" ? approveProposal(next, id, now) : rejectProposal(next, id, now);
      }
      writeLedger(file, next);
      console.log(
        `${rest.join(" ")} ${command === "approve" ? "approved: applied at the next 04:00 run" : "rejected"}`,
      );
      return 0;
    }
    case "run-commits":
      console.log(
        JSON.stringify(
          appliedInRun(ledger, needRun()).map((entry) => ({
            id: entry.id,
            commits: entry.commits,
          })),
        ),
      );
      return 0;
    case "run-reverted":
      writeLedger(file, markRunReverted(ledger, needRun(), need(parsed, "reason"), now));
      return 0;
    case "run-shipped":
      writeLedger(file, markRunShipped(ledger, needRun(), need(parsed, "version"), now));
      return 0;
    case "report": {
      const outcome = JSON.parse(
        NodeFS.readFileSync(need(parsed, "outcome"), "utf8").replace(/^\uFEFF/, ""),
      ) as RunOutcome;
      process.stdout.write(`${renderMorningReport(ledger, outcome)}\n`);
      return 0;
    }
    default:
      throw new LedgerError(
        `Unknown command '${command ?? ""}'. See the header of scripts/personal/updates/ledger.ts.`,
      );
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof LedgerError ? 2 : 1;
}
