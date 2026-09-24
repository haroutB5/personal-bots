import { assert, describe, it } from "@effect/vitest";

import {
  actionableProposals,
  addProposal,
  approveProposal,
  awaitingApproval,
  decideProposal,
  EMPTY_LEDGER,
  isUrgentReport,
  LedgerError,
  markApplied,
  markFailed,
  markRunReverted,
  markRunShipped,
  parseLedger,
  rejectProposal,
  renderMorningReport,
  serializeLedger,
  URGENT_REPORT_PREFIX,
  type ProposalLedger,
  type RunOutcome,
} from "./proposalLedger.ts";

const AT = "2026-09-25T03:10:00.000Z";
const RUN = "20260925-0400";

const seeded = (): ProposalLedger => {
  let ledger = EMPTY_LEDGER;
  for (const title of ["Bump SDK", "Snapshot off", "Installed version", "Plan panel", "Hints"]) {
    ledger = addProposal(ledger, { title, source: "2.1.281" }, AT, null).ledger;
  }
  return ledger;
};

const status = (ledger: ProposalLedger) =>
  Object.fromEntries(ledger.proposals.map((entry) => [entry.id, entry.status]));

const outcome = (overrides: Partial<RunOutcome> = {}): RunOutcome => ({
  runId: RUN,
  mode: "live",
  result: "shipped",
  summary: "Two proposals applied; gates green; 1.35.1 live.",
  version: "1.35.1",
  release: "abc123def456",
  previousRelease: "000111222333",
  steps: ["gates green", "restart ok"],
  urgent: false,
  review: null,
  finishedAt: "2026-09-25T03:45:00.000Z",
  ...overrides,
});

describe("proposal ledger", () => {
  it("numbers proposals globally and never reuses a number", () => {
    const ledger = seeded();
    assert.deepStrictEqual(
      ledger.proposals.map((entry) => entry.id),
      ["P1", "P2", "P3", "P4", "P5"],
    );
    const next = addProposal(ledger, { title: "New thing", source: "2.1.282" }, AT, RUN);
    assert.strictEqual(next.id, "P6");
    // A round trip keeps the counter even if the file lost it.
    const reloaded = parseLedger(serializeLedger({ ...next.ledger, nextNumber: 1 }));
    assert.strictEqual(reloaded.nextNumber, 7);
  });

  it("carries undecided and approved proposals; risky ones wait for approval", () => {
    let ledger = seeded();
    ledger = decideProposal(ledger, "P1", "safe", "small, tested", AT, RUN);
    ledger = decideProposal(ledger, "P4", "risky", "UI and model behaviour", AT, RUN);
    ledger = rejectProposal(ledger, "P5", AT);
    assert.deepStrictEqual(status(ledger), {
      P1: "open",
      P2: "open",
      P3: "open",
      P4: "needs-approval",
      P5: "rejected",
    });
    assert.deepStrictEqual(
      actionableProposals(ledger).map((entry) => entry.id),
      ["P1", "P2", "P3"],
    );
    assert.deepStrictEqual(
      awaitingApproval(ledger).map((entry) => entry.id),
      ["P4"],
    );
    // "approve P4" carries it into the next run.
    ledger = approveProposal(ledger, "p4", AT);
    assert.deepStrictEqual(
      actionableProposals(ledger).map((entry) => entry.id),
      ["P1", "P2", "P3", "P4"],
    );
    // An approved proposal stays approved whatever the run rates it.
    ledger = decideProposal(ledger, "P4", "risky", "still risky", AT, RUN);
    assert.strictEqual(status(ledger).P4, "approved");
  });

  it("records the safe/risky decision with its reason and history", () => {
    const ledger = decideProposal(seeded(), "P3", "safe", "one-line fallback", AT, RUN);
    const entry = ledger.proposals.find((item) => item.id === "P3")!;
    assert.strictEqual(entry.rating, "safe");
    assert.strictEqual(entry.reason, "one-line fallback");
    assert.strictEqual(entry.runId, RUN);
    assert.deepStrictEqual(entry.history.at(-1), {
      at: AT,
      runId: RUN,
      event: "rated safe",
      detail: "one-line fallback",
    });
  });

  it("applies only what was rated safe or approved, with its commits", () => {
    let ledger = seeded();
    assert.throws(() => markApplied(ledger, "P1", ["abc"], "", AT, RUN), LedgerError);
    ledger = decideProposal(ledger, "P1", "safe", "ok", AT, RUN);
    assert.throws(() => markApplied(ledger, "P1", [], "", AT, RUN), LedgerError);
    ledger = markApplied(ledger, "P1", ["abc1234"], "Before: x. After: y.", AT, RUN);
    assert.strictEqual(status(ledger).P1, "applied");
    ledger = approveProposal(ledger, "P2", AT);
    ledger = markApplied(ledger, "P2", ["def5678"], "", AT, RUN);
    assert.strictEqual(status(ledger).P2, "applied");
    assert.throws(() => approveProposal(ledger, "P2", AT), LedgerError);
  });

  it("a run that shipped marks what it applied as shipped in that version", () => {
    let ledger = decideProposal(seeded(), "P1", "safe", "ok", AT, RUN);
    ledger = markApplied(ledger, "P1", ["abc1234"], "", AT, RUN);
    ledger = markRunShipped(ledger, RUN, "1.35.1", AT);
    const entry = ledger.proposals.find((item) => item.id === "P1")!;
    assert.strictEqual(entry.status, "shipped");
    assert.strictEqual(entry.version, "1.35.1");
  });

  it("a reverted run sends what it applied back for approval; other runs are untouched", () => {
    let ledger = decideProposal(seeded(), "P1", "safe", "ok", AT, RUN);
    ledger = markApplied(ledger, "P1", ["abc1234"], "", AT, RUN);
    ledger = decideProposal(ledger, "P2", "safe", "ok", AT, "other-run");
    ledger = markApplied(ledger, "P2", ["fff0000"], "", AT, "other-run");
    ledger = markRunReverted(ledger, RUN, "gates red: test-server", AT);
    assert.strictEqual(status(ledger).P1, "needs-approval");
    assert.strictEqual(
      ledger.proposals.find((item) => item.id === "P1")!.reason,
      "reverted: gates red: test-server",
    );
    assert.strictEqual(status(ledger).P2, "applied");
  });

  it("a proposal the bot could not implement waits for approval", () => {
    const ledger = markFailed(seeded(), "P2", "no way to verify", AT, RUN);
    assert.strictEqual(status(ledger).P2, "needs-approval");
    assert.strictEqual(
      ledger.proposals.find((item) => item.id === "P2")!.reason,
      "could not be applied: no way to verify",
    );
  });

  it("reads an empty or missing file as empty and refuses a corrupt one", () => {
    assert.deepStrictEqual(parseLedger(null), EMPTY_LEDGER);
    assert.deepStrictEqual(parseLedger("  "), EMPTY_LEDGER);
    assert.throws(() => parseLedger("{"), LedgerError);
    assert.throws(() => parseLedger('{"proposals":[{"id":"X1"}]}'), LedgerError);
    // A BOM (PowerShell's UTF8) is fine.
    assert.strictEqual(parseLedger(`\uFEFF${serializeLedger(seeded())}`).proposals.length, 5);
  });
});

describe("morning report", () => {
  const ledgerAfterRun = () => {
    let ledger = seeded();
    ledger = decideProposal(ledger, "P1", "safe", "ok", AT, RUN);
    ledger = markApplied(
      ledger,
      "P1",
      ["abc1234567890"],
      "Before: 0.3.260. After: 0.3.281.",
      AT,
      RUN,
    );
    ledger = decideProposal(ledger, "P4", "risky", "changes model behaviour", AT, RUN);
    ledger = decideProposal(ledger, "P5", "risky", "old reason", AT, "earlier-run");
    return ledger;
  };

  it("lists applied with commits and version, skipped with reasons, and what still waits", () => {
    const ledger = markRunShipped(ledgerAfterRun(), RUN, "1.35.1", AT);
    const text = renderMorningReport(ledger, outcome());
    assert.ok(text.startsWith("Nightly update 2026-09-25: shipped 1.35.1"));
    assert.ok(
      text.includes(
        "Applied and live\n- P1 Bump SDK. Commits abc1234567 (in 1.35.1). Before: 0.3.260. After: 0.3.281.",
      ),
    );
    assert.ok(
      text.includes(
        "Skipped (reply 'approve P<n>' to have it applied tonight)\n- P4 Plan panel. changes model behaviour",
      ),
    );
    assert.ok(text.includes("Still waiting for your approval: P5 (Hints)"));
    assert.ok(text.includes("- release abc123def456, rollback target 000111222333"));
    assert.strictEqual(isUrgentReport(text), false);
  });

  it("a rolled-back run lists its reverted proposals", () => {
    const ledger = markRunReverted(ledgerAfterRun(), RUN, "the new release failed its smoke", AT);
    const text = renderMorningReport(ledger, outcome({ result: "rolled-back", version: null }));
    assert.ok(text.startsWith("Nightly update 2026-09-25: rolled back"));
    assert.ok(
      text.includes(
        "Reverted (reply 'approve P<n>' to retry tonight)\n- P1 Bump SDK. reverted: the new release failed its smoke",
      ),
    );
  });

  it("an urgent report starts with the marker the push service reads", () => {
    const text = renderMorningReport(ledgerAfterRun(), outcome({ result: "down", urgent: true }));
    assert.ok(
      text.startsWith(`${URGENT_REPORT_PREFIX}: Nightly update 2026-09-25: Bots may be down`),
    );
    assert.strictEqual(isUrgentReport(text), true);
  });

  it("a dry run says so", () => {
    const text = renderMorningReport(
      ledgerAfterRun(),
      outcome({ mode: "dry-run", result: "dry-run" }),
    );
    assert.ok(text.startsWith("Dry run of the nightly update 2026-09-25: dry run 1.35.1"));
    assert.ok(text.includes("Rehearsal only"));
  });
});
