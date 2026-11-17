// The test-line budget: the pure rules, then the planner command and the seal over real git history.
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
const SCRATCH = NodePath.join(ROOT, "../../../../.tmp");
NodeFS.mkdirSync(SCRATCH, { recursive: true });

const A = "scripts/personal/node/test/a.test.mjs";
const B = "scripts/personal/node/test/b.test.mjs";
const ROW = {
  change: "feat/big",
  lines: 480,
  reason: "two tests replace a device check",
  strongest: A,
  by: "Poteto",
};
const d = (path, net) => ({ path, net });
const judge = (deltas, extra) => judgeChange({ id: "feat/x", deltas, ...extra });
const file = (rows, limit) => JSON.stringify({ limit, allowances: rows });

NodeTest.describe("the verdict", () => {
  NodeTest.it("counts test files of the fork trees only", () => {
    const counted = [A, "apps/hbots-mobile/src/a.test.ts", "apps/server/src/personal/a.test.ts"];
    const ignored = [
      "apps/web/src/a.test.ts",
      "apps/server/src/auth/a.test.ts",
      "apps/hbots-mobile/src/a.ts",
    ];
    NodeAssert.deepEqual(counted.filter(isForkTest), counted);
    NodeAssert.deepEqual(ignored.filter(isForkTest), []);
    NodeAssert.equal(judge([d("apps/web/src/a.test.ts", 5000), d(A, 10)]).net, 10);
  });

  const table = [
    ["passes a change at the limit", [d(A, 300), d(B, 100)], undefined, "ok"],
    ["fails a change one line over across two files", [d(A, 300), d(B, 101)], undefined, "over"],
    ["never blocks a lone test file at any size", [d(A, 900)], undefined, "single-file"],
    ["subtracts deleted lines", [d(A, 450), d(B, -100)], undefined, "ok"],
    ["passes a change inside its allowance", [d(A, 290), d(B, 190)], ROW, "allowed"],
    ["fails a change past its allowance", [d(A, 290), d(B, 191)], ROW, "over"],
  ];
  for (const [name, deltas, allowance, verdict] of table)
    NodeTest.it(name, () => NodeAssert.equal(judge(deltas, { allowance }).verdict, verdict));

  NodeTest.it("prints the fix list for a change over the limit", () => {
    const result = judge([d(A, 290), d(B, 158)], { code: { added: 158, deleted: 95 } });
    NodeAssert.deepEqual(budgetLines(result), [
      "FAIL test budget: feat/x +448 net test lines in 2 files, limit 400, over by 48",
      `  +290 ${A}`,
      `  +158 ${B}`,
      "  code in this change: +158 -95",
      "  to pass: delete or merge 48 test lines the new tests make redundant, or ask the lead",
      `  for a row in ${ALLOWANCE_FILE}`,
    ]);
    const allowed = judge([d(A, 290), d(B, 158)], { allowance: ROW });
    NodeAssert.match(budgetLines(allowed)[0], /allowed 448 of 480 by Poteto: two tests replace/);
  });
});

NodeTest.describe("the allowance rows a change adds", () => {
  NodeTest.it("takes only rows present at head and absent at base, with the base's limit", () => {
    const old = { ...ROW, change: "fix/old" };
    const found = newAllowances(file([old], 300), file([old, ROW], 9000));
    NodeAssert.deepEqual(found, { limit: 300, rows: [ROW], problems: [] });
    NodeAssert.deepEqual(newAllowances(null, null), { limit: 400, rows: [], problems: [] });
  });

  NodeTest.it("refuses a new row that is incomplete or names no test in the tree", () => {
    const bad = (patch, exists) =>
      newAllowances(null, file([{ ...ROW, ...patch }]), { exists }).problems.join(" ");
    NodeAssert.match(bad({ reason: " " }), /reason is required/);
    NodeAssert.match(bad({ strongest: "" }), /strongest is required/);
    NodeAssert.match(bad({ strongest: "apps/hbots-mobile/src/Composer.tsx" }), /not a test file/);
    NodeAssert.match(bad({ lines: 12.5 }), /lines must be a positive whole number/);
    NodeAssert.match(
      bad({}, () => false),
      /strongest .* is not a test file in this change/,
    );
  });

  NodeTest.it("fails on a malformed file, never passes silently", () => {
    NodeAssert.match(newAllowances(null, "{ nope").problems.join(" "), /at head is not valid JSON/);
    NodeAssert.match(newAllowances("[1", null).problems.join(" "), /at base is not valid JSON/);
    NodeAssert.match(newAllowances(null, "{}").problems.join(" "), /needs an allowances array/);
  });
});

const git = (repo, ...args) => {
  const result = NodeChildProcess.spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  NodeAssert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const body = (count, tag) => Array.from({ length: count }, (_, i) => `// ${tag} ${i}\n`).join("");
const write = (repo, path, text) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, path), text);
};
const commit = (repo, message) => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};
const big = (repo, extra = {}) => {
  write(repo, A, body(300, "a"));
  write(repo, B, body(200, "b"));
  for (const [path, text] of Object.entries(extra)) write(repo, path, text);
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
  try {
    run({ repo, trunk: commit(repo, "trunk"), dir });
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

function branch(repo, name, edit) {
  git(repo, "checkout", "-q", "-b", name, "trunk");
  edit();
  commit(repo, name);
  git(repo, "checkout", "-q", "trunk");
}

const cli = (repo, base, head) => {
  const gateScope = NodePath.join(ROOT, "lib/gateScope.mjs");
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [gateScope, "--base", base, "--head", head, "--repo", repo],
    { encoding: "utf8" },
  );
  return { code: result.status, out: result.stdout, err: result.stderr };
};

NodeTest.describe("the planner command", () => {
  const plan = (edit) => {
    let result;
    withRepo(({ repo, trunk }) => {
      branch(repo, "feat/x", () => edit(repo));
      result = cli(repo, trunk, "feat/x");
    });
    return result;
  };

  NodeTest.it("prints one line and exits 0 for a small change and for a lone test file", () => {
    const small = plan((repo) => write(repo, A, body(50, "a")));
    NodeAssert.equal(small.code, 0, small.err);
    NodeAssert.match(small.out, /feat\/x \+40 net test lines in 1 file \(limit 400\): ok/);
    const lone = plan((repo) => write(repo, A, body(2000, "a")));
    NodeAssert.equal(lone.code, 0, lone.err);
    NodeAssert.match(lone.out, /single-file/);
  });

  NodeTest.it("exits 2 and names the files for a change over the limit", () => {
    const result = plan((repo) => big(repo));
    NodeAssert.equal(result.code, 2);
    NodeAssert.match(
      result.err,
      /FAIL test budget: feat\/x \+480 net test lines in 2 files, limit 400, over by 80/,
    );
    NodeAssert.match(result.err, /\+290 scripts\/personal\/node\/test\/a\.test\.mjs/);
  });

  NodeTest.it("lets a change through on a row it adds, and refuses a row with no reason", () => {
    const row = (patch) => ({ [ALLOWANCE_FILE]: file([{ ...ROW, ...patch }]) });
    const allowed = plan((repo) => big(repo, row({})));
    NodeAssert.equal(allowed.code, 0, allowed.err);
    NodeAssert.match(allowed.out, /allowed 480 of 480 by Poteto/);
    const bad = plan((repo) => big(repo, row({ lines: 9000, reason: "" })));
    NodeAssert.equal(bad.code, 2);
    NodeAssert.match(bad.err, /reason is required/);
  });

  NodeTest.it("does not let a row already on trunk excuse a later change", () =>
    withRepo(({ repo }) => {
      write(repo, ALLOWANCE_FILE, file([{ ...ROW, lines: 9000 }]));
      const base = commit(repo, "an earlier change's row lands on trunk");
      branch(repo, "feat/later", () => big(repo));
      NodeAssert.equal(cli(repo, base, "feat/later").code, 2);
    }),
  );

  NodeTest.it("subtracts the lines a change deletes", () =>
    withRepo(({ repo }) => {
      write(repo, B, body(300, "b"));
      const base = commit(repo, "a longer test lands on trunk");
      branch(repo, "fix/swap", () => {
        write(repo, A, body(460, "a"));
        write(repo, B, body(100, "b"));
      });
      const result = cli(repo, base, "fix/swap");
      NodeAssert.equal(result.code, 0, result.err);
      NodeAssert.match(result.out, /\+250 net test lines in 2 files/);
    }),
  );
});

NodeTest.describe("the release walk", () => {
  const merge = (repo, name) =>
    git(repo, "merge", "--no-ff", "-q", "-m", `Merge branch '${name}'`, name);
  const head = (repo) => git(repo, "rev-parse", "HEAD");
  const C = "scripts/personal/node/test/c.test.mjs";

  NodeTest.it("measures each merged change on its own and names the one over the limit", () =>
    withRepo(({ repo, trunk }) => {
      branch(repo, "fix/one", () => write(repo, C, body(250, "c")));
      branch(repo, "fix/two", () =>
        write(repo, "scripts/personal/node/test/d.test.mjs", body(250, "d")),
      );
      merge(repo, "fix/one");
      merge(repo, "fix/two");
      const small = budgetOfRelease(repo, trunk, head(repo));
      NodeAssert.deepEqual(small.problems, []);
      NodeAssert.deepEqual(
        small.reports.map((r) => [r.result.id, r.result.net]),
        [
          ["fix/two", 250],
          ["fix/one", 250],
        ],
      );
      branch(repo, "feat/big", () => big(repo));
      merge(repo, "feat/big");
      const over = budgetOfRelease(repo, trunk, head(repo));
      NodeAssert.equal(over.problems.length, 1);
      NodeAssert.match(over.problems[0], /^test budget: feat\/big \+480 net test lines in 2 files/);
    }),
  );

  NodeTest.it("skips live trunk merged into the release branch and sums straight commits", () =>
    withRepo(({ repo, trunk }) => {
      branch(repo, "feat/big", () => big(repo));
      merge(repo, "feat/big");
      const live = head(repo);
      git(repo, "checkout", "-q", "-b", "rc", trunk);
      write(repo, C, body(5, "c"));
      commit(repo, "rc work");
      git(repo, "merge", "--no-ff", "-q", "-m", "Merge branch 'trunk' into rc", live);
      const report = budgetOfRelease(repo, live, head(repo));
      NodeAssert.deepEqual(report.problems, []);
      NodeAssert.deepEqual(
        report.reports.map((r) => r.result.id),
        ["commits made on the release line"],
      );
      write(repo, A, body(700, "x"));
      commit(repo, "one");
      write(repo, B, body(400, "y"));
      commit(repo, "two");
      NodeAssert.match(
        budgetOfRelease(repo, live, head(repo)).problems.join(),
        /release line \+\d+ net test lines in 3 files/,
      );
    }),
  );

  NodeTest.it("makes the seal refuse a release that carries a change over the limit", () =>
    withRepo(({ repo, trunk, dir }) => {
      branch(repo, "feat/big", () => big(repo));
      merge(repo, "feat/big");
      NodeFS.writeFileSync(NodePath.join(dir, "current.txt"), `${trunk}\n`);
      const cfg = { currentTxt: NodePath.join(dir, "current.txt") };
      const problems = planEvidenceProblems(
        cfg,
        { "repo-root": repo, release: head(repo) },
        { gates: [] },
      );
      NodeAssert.match(
        problems.join(" "),
        /test budget: feat\/big \+480 net test lines in 2 files, limit 400, over by 80/,
      );
    }),
  );
});
