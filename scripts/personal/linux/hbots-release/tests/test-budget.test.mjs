// The test-line budget: the pure rules, then the planner CLI and the seal over real git history.
// Run with node --test.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import {
  ALLOWANCE_FILE,
  budgetLines,
  isForkTest,
  judgeChange,
  newAllowances,
} from "../lib/testBudget.mjs";
import { budgetOfRelease } from "../lib/gateScope.mjs";
import { planEvidenceProblems } from "../lib/seal.mjs";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const REPO = NodePath.resolve(ROOT, "../../../..");
const SCRATCH = NodePath.join(REPO, ".tmp");
NodeFS.mkdirSync(SCRATCH, { recursive: true });

const A = "scripts/personal/node/test/a.test.mjs";
const B = "scripts/personal/node/test/b.test.mjs";
const ROW = {
  change: "feat/big",
  lines: 460,
  reason: "two reconciler tests replace the device check",
  strongest: A,
  by: "Poteto",
  date: "2026-11-17",
};
const delta = (path, net) => ({ path, net });
const judge = (deltas, extra = {}) => judgeChange({ id: "feat/x", deltas, ...extra });

NodeTest.describe("which lines count", () => {
  NodeTest.it("counts test files of the fork trees only", () => {
    NodeAssert.ok(isForkTest("apps/hbots-mobile/src/chat/markdown.test.ts"));
    NodeAssert.ok(isForkTest("apps/server/src/personal/push/PersonalPushService.test.ts"));
    NodeAssert.ok(isForkTest("packages/personal-client/src/feed/chatFeed.test.ts"));
    NodeAssert.ok(isForkTest("scripts/personal/node/test/units.test.mjs"));
    NodeAssert.ok(isForkTest("scripts/personal/sqlite-snapshot.test.cjs"));
    NodeAssert.ok(isForkTest("apps/hbots-mobile/modules/hbots-camera/android/src/test/java/A.kt"));
    NodeAssert.ok(!isForkTest("apps/web/src/features/personal/Chat.test.tsx"));
    NodeAssert.ok(!isForkTest("apps/server/src/auth/http.test.ts"));
    NodeAssert.ok(
      !isForkTest("scripts/personal/linux/hbots-release/tests/fixtures/planner-replay.json"),
    );
    NodeAssert.ok(!isForkTest("apps/hbots-mobile/src/chat/MessageList.tsx"));
  });

  NodeTest.it("ignores a changed upstream test", () => {
    const result = judge([delta("apps/web/src/a.test.ts", 5000), delta(A, 10)]);
    NodeAssert.equal(result.net, 10);
    NodeAssert.equal(result.files, 1);
  });
});

NodeTest.describe("the verdict", () => {
  NodeTest.it("passes a change at the limit and fails one line over across two files", () => {
    NodeAssert.equal(judge([delta(A, 300), delta(B, 100)]).verdict, "ok");
    const over = judge([delta(A, 300), delta(B, 101)]);
    NodeAssert.equal(over.verdict, "over");
    NodeAssert.equal(over.net, 401);
  });

  NodeTest.it("never blocks a change whose test lines sit in one file", () => {
    const result = judge([delta(A, 900)]);
    NodeAssert.equal(result.verdict, "single-file");
    NodeAssert.deepEqual(budgetLines(result), [
      `test budget: feat/x +900 net test lines in 1 file (limit 400): single-file, never blocked, +900 in ${A}`,
    ]);
  });

  NodeTest.it("subtracts deleted lines, so a stronger replacement pays the difference", () => {
    NodeAssert.equal(judge([delta(A, 450), delta(B, -100)]).verdict, "ok");
    NodeAssert.equal(
      judge([delta(A, 700), delta(B, -300), delta("scripts/personal/x.test.mjs", -1)]).net,
      399,
    );
  });

  NodeTest.it("passes a change inside its allowance and fails it past the number", () => {
    const deltas = [delta(A, 290), delta(B, 158)];
    const allowed = judge(deltas, { allowance: ROW });
    NodeAssert.equal(allowed.verdict, "allowed");
    NodeAssert.match(budgetLines(allowed)[0], /allowed 448 of 460 by Poteto: two reconciler tests/);
    NodeAssert.equal(judge(deltas, { allowance: { ...ROW, lines: 447 } }).verdict, "over");
  });

  NodeTest.it("prints the fix list for a change over the limit", () => {
    const result = judge([delta(A, 290), delta(B, 158)], { code: { added: 158, deleted: 95 } });
    NodeAssert.deepEqual(budgetLines(result), [
      "FAIL test budget: feat/x +448 net test lines in 2 files, limit 400, over by 48",
      `  +290 ${A}`,
      `  +158 ${B}`,
      "  code in this change: +158 -95",
      "  to pass: delete or merge 48 test lines the new tests make redundant, or ask the lead",
      `  for a row in ${ALLOWANCE_FILE}`,
    ]);
  });
});

NodeTest.describe("the allowance rows a change adds", () => {
  const file = (rows, limit) => JSON.stringify({ ...(limit ? { limit } : {}), allowances: rows });

  NodeTest.it("takes the rows present at head and absent at base", () => {
    const old = { ...ROW, change: "fix/old" };
    const found = newAllowances(file([old]), file([old, ROW]));
    NodeAssert.deepEqual(found.rows, [ROW]);
    NodeAssert.deepEqual(found.problems, []);
  });

  NodeTest.it("reads a file that does not exist as no rows and the default limit", () => {
    NodeAssert.deepEqual(newAllowances(null, null), { limit: 400, rows: [], problems: [] });
  });

  NodeTest.it("uses the limit at base, so a change cannot raise its own", () => {
    NodeAssert.equal(newAllowances(file([], 300), file([], 9000)).limit, 300);
  });

  NodeTest.it(
    "refuses a new row without a reason, a strongest test, or a whole positive number",
    () => {
      const bad = (patch) => newAllowances(null, file([{ ...ROW, ...patch }])).problems.join(" ");
      NodeAssert.match(bad({ reason: " " }), /reason is required/);
      NodeAssert.match(bad({ strongest: "" }), /strongest is required/);
      NodeAssert.match(
        bad({ strongest: "apps/hbots-mobile/src/chat/Composer.tsx" }),
        /not a test file/,
      );
      NodeAssert.match(bad({ lines: 12.5 }), /lines must be a positive whole number/);
      NodeAssert.match(bad({ lines: 0 }), /lines must be a positive whole number/);
    },
  );

  NodeTest.it("refuses a strongest test that is not in the tree at head", () => {
    const found = newAllowances(null, file([ROW]), { exists: () => false });
    NodeAssert.match(
      found.problems.join(" "),
      /feat\/big: strongest .* is not a test file in this change/,
    );
    NodeAssert.deepEqual(found.rows, []);
  });

  NodeTest.it("fails on a malformed file at head or base, never passes silently", () => {
    NodeAssert.match(
      newAllowances(null, "{ nope").problems.join(" "),
      /allowance file at head is not valid JSON/,
    );
    NodeAssert.match(
      newAllowances("[1", null).problems.join(" "),
      /allowance file at base is not valid JSON/,
    );
    NodeAssert.match(newAllowances(null, "{}").problems.join(" "), /needs an allowances array/);
  });
});

const git = (repo, ...args) => {
  const result = NodeChildProcess.spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  NodeAssert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const body = (count, tag) =>
  Array.from({ length: count }, (_, index) => `// ${tag} ${index}\n`).join("");
const write = (repo, file, text) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, file), text);
};
const commit = (repo, message) => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};

function withRepo(run) {
  const dir = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "test-budget-"));
  const repo = NodePath.join(dir, "repo");
  NodeFS.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "trunk");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  write(repo, A, body(10, "a"));
  write(repo, B, body(10, "b"));
  const trunk = commit(repo, "trunk");
  try {
    run({ repo, trunk, dir });
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

const branchOf = (repo, name, edit) => {
  git(repo, "checkout", "-q", "-b", name, "trunk");
  edit();
  const head = commit(repo, name);
  git(repo, "checkout", "-q", "trunk");
  return head;
};

const cli = (repo, base, head) => {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(ROOT, "lib/gateScope.mjs"), "--base", base, "--head", head, "--repo", repo],
    { encoding: "utf8" },
  );
  return { code: result.status, out: result.stdout, err: result.stderr };
};

NodeTest.describe("the planner command", () => {
  NodeTest.it("prints one line and exits 0 for a small change", () =>
    withRepo(({ repo, trunk }) => {
      branchOf(repo, "fix/small", () => write(repo, A, body(50, "a")));
      const result = cli(repo, trunk, "fix/small");
      NodeAssert.equal(result.code, 0, result.err);
      NodeAssert.match(
        result.out,
        /test budget: fix\/small \+40 net test lines in 1 file \(limit 400\): ok/,
      );
    }),
  );

  NodeTest.it("subtracts the lines a change deletes", () =>
    withRepo(({ repo }) => {
      write(repo, B, body(300, "b"));
      const base = commit(repo, "a longer test lands on trunk");
      branchOf(repo, "fix/swap", () => {
        write(repo, A, body(460, "a"));
        write(repo, B, body(100, "b"));
      });
      const result = cli(repo, base, "fix/swap");
      NodeAssert.equal(result.code, 0, result.err);
      NodeAssert.match(result.out, /fix\/swap \+250 net test lines in 2 files \(limit 400\): ok/);
    }),
  );

  NodeTest.it("exits 2 and names the files for a change over the limit", () =>
    withRepo(({ repo, trunk }) => {
      branchOf(repo, "feat/big", () => {
        write(repo, A, body(300, "a"));
        write(repo, B, body(200, "b"));
      });
      const result = cli(repo, trunk, "feat/big");
      NodeAssert.equal(result.code, 2);
      NodeAssert.match(
        result.err,
        /FAIL test budget: feat\/big \+480 net test lines in 2 files, limit 400, over by 80/,
      );
      NodeAssert.match(result.err, /\+290 scripts\/personal\/node\/test\/a\.test\.mjs/);
      NodeAssert.match(
        result.err,
        /for a row in scripts\/personal\/qa\/test-budget-allowances\.json/,
      );
    }),
  );

  NodeTest.it("lets a lone test file through at any size", () =>
    withRepo(({ repo, trunk }) => {
      branchOf(repo, "fix/lone", () => write(repo, A, body(2000, "a")));
      const result = cli(repo, trunk, "fix/lone");
      NodeAssert.equal(result.code, 0, result.err);
      NodeAssert.match(result.out, /single-file/);
    }),
  );

  NodeTest.it("lets a change over the limit through on a row it adds, and prints the row", () =>
    withRepo(({ repo, trunk }) => {
      branchOf(repo, "feat/big", () => {
        write(repo, A, body(300, "a"));
        write(repo, B, body(200, "b"));
        write(repo, ALLOWANCE_FILE, JSON.stringify({ allowances: [{ ...ROW, lines: 480 }] }));
      });
      const result = cli(repo, trunk, "feat/big");
      NodeAssert.equal(result.code, 0, result.err);
      NodeAssert.match(result.out, /allowed 480 of 480 by Poteto: two reconciler tests/);
    }),
  );

  NodeTest.it("does not let a row already on trunk excuse a later change", () =>
    withRepo(({ repo }) => {
      write(repo, ALLOWANCE_FILE, JSON.stringify({ allowances: [{ ...ROW, lines: 9000 }] }));
      const withRow = commit(repo, "an earlier change's row lands on trunk");
      branchOf(repo, "feat/later", () => {
        write(repo, A, body(300, "a"));
        write(repo, B, body(200, "b"));
      });
      const result = cli(repo, withRow, "feat/later");
      NodeAssert.equal(result.code, 2, result.out);
    }),
  );

  NodeTest.it("fails a change that adds a row with no reason", () =>
    withRepo(({ repo, trunk }) => {
      branchOf(repo, "feat/big", () => {
        write(repo, A, body(300, "a"));
        write(repo, B, body(200, "b"));
        write(
          repo,
          ALLOWANCE_FILE,
          JSON.stringify({ allowances: [{ ...ROW, lines: 9000, reason: "" }] }),
        );
      });
      const result = cli(repo, trunk, "feat/big");
      NodeAssert.equal(result.code, 2);
      NodeAssert.match(result.err, /reason is required/);
    }),
  );
});

NodeTest.describe("the release walk", () => {
  const merge = (repo, name) =>
    git(repo, "merge", "--no-ff", "-q", "-m", `Merge branch '${name}'`, name);

  NodeTest.it("measures each merged change on its own, so two small changes pass together", () =>
    withRepo(({ repo, trunk }) => {
      branchOf(repo, "fix/one", () => {
        write(repo, A, body(250, "a"));
        write(repo, "scripts/personal/node/test/c.test.mjs", body(100, "c"));
      });
      branchOf(repo, "fix/two", () => {
        write(repo, B, body(250, "b"));
        write(repo, "scripts/personal/node/test/d.test.mjs", body(100, "d"));
      });
      merge(repo, "fix/one");
      merge(repo, "fix/two");
      const report = budgetOfRelease(repo, trunk, git(repo, "rev-parse", "HEAD"));
      NodeAssert.deepEqual(report.problems, []);
      NodeAssert.deepEqual(
        report.reports.map((entry) => [entry.result.id, entry.result.net]),
        [
          ["fix/two", 340],
          ["fix/one", 340],
        ],
      );
    }),
  );

  NodeTest.it("names the merged change that is over the limit", () =>
    withRepo(({ repo, trunk }) => {
      branchOf(repo, "fix/small", () =>
        write(repo, "scripts/personal/node/test/s.test.mjs", body(20, "s")),
      );
      branchOf(repo, "feat/big", () => {
        write(repo, A, body(300, "a"));
        write(repo, B, body(200, "b"));
      });
      merge(repo, "fix/small");
      merge(repo, "feat/big");
      const report = budgetOfRelease(repo, trunk, git(repo, "rev-parse", "HEAD"));
      NodeAssert.equal(report.problems.length, 1);
      NodeAssert.match(report.problems[0], /^test budget: feat\/big \+/);
    }),
  );

  NodeTest.it("skips a merge of live trunk into the release branch", () =>
    withRepo(({ repo, trunk }) => {
      branchOf(repo, "feat/big", () => {
        write(repo, A, body(300, "a"));
        write(repo, B, body(200, "b"));
      });
      merge(repo, "feat/big");
      const live = git(repo, "rev-parse", "HEAD");
      git(repo, "checkout", "-q", "-b", "rc", trunk);
      write(repo, "scripts/personal/node/test/c.test.mjs", body(5, "c"));
      commit(repo, "rc work");
      git(repo, "merge", "--no-ff", "-q", "-m", "Merge branch 'trunk' into rc", live);
      const report = budgetOfRelease(repo, live, git(repo, "rev-parse", "HEAD"));
      NodeAssert.deepEqual(report.problems, []);
      NodeAssert.deepEqual(
        report.reports.map((entry) => entry.result.id),
        ["commits made on the release line"],
      );
    }),
  );

  NodeTest.it("counts commits made straight on the release line as one change", () =>
    withRepo(({ repo, trunk }) => {
      write(repo, A, body(250, "a"));
      commit(repo, "one");
      write(repo, B, body(250, "b"));
      commit(repo, "two");
      const report = budgetOfRelease(repo, trunk, git(repo, "rev-parse", "HEAD"));
      NodeAssert.equal(report.problems.length, 1);
      NodeAssert.match(
        report.problems[0],
        /commits made on the release line \+480 net test lines in 2 files/,
      );
    }),
  );

  NodeTest.it("makes the seal refuse a release that carries a change over the limit", () =>
    withRepo(({ repo, trunk, dir }) => {
      branchOf(repo, "feat/big", () => {
        write(repo, A, body(300, "a"));
        write(repo, B, body(200, "b"));
      });
      merge(repo, "feat/big");
      const head = git(repo, "rev-parse", "HEAD");
      NodeFS.writeFileSync(NodePath.join(dir, "current.txt"), `${trunk}\n`);
      const problems = planEvidenceProblems(
        { currentTxt: NodePath.join(dir, "current.txt") },
        { "repo-root": repo, release: head },
        { gates: [] },
      );
      NodeAssert.match(
        problems.join(" "),
        /test budget: feat\/big \+480 net test lines in 2 files, limit 400, over by 80/,
      );
    }),
  );
});
