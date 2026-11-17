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
const C = "scripts/personal/node/test/c.test.mjs";
const ROW = {
  change: "feat/big",
  lines: 480,
  reason: "two tests replace a device check",
  strongest: A,
  by: "Poteto",
};
const d = (path, net) => ({ path, net });
const judge = (deltas, extra) => judgeChange({ id: "feat/x", deltas, ...extra });
const file = (rows, limit, enforce) => JSON.stringify({ limit, enforce, allowances: rows });

NodeTest.describe("the verdict", () => {
  NodeTest.it("counts test files of the fork trees only", () => {
    const kotlin = "apps/hbots-mobile/modules/camera/android/src/test/java/CameraTest.kt";
    const counted = [
      A,
      "apps/hbots-mobile/src/a.test.ts",
      "apps/server/src/personal/a.test.ts",
      kotlin,
    ];
    const ignored = [
      "apps/web/src/a.test.ts",
      "apps/server/src/auth/a.test.ts",
      "apps/hbots-mobile/src/a.ts",
      "apps/hbots-mobile/modules/camera/android/src/main/java/Camera.kt",
    ];
    NodeAssert.deepEqual(counted.filter(isForkTest), counted);
    NodeAssert.deepEqual(ignored.filter(isForkTest), []);
    NodeAssert.equal(judge([d("apps/web/src/a.test.ts", 5000), d(A, 10)]).net, 10);
  });

  const table = [
    ["passes a change at the limit", [d(A, 300), d(B, 100)], undefined, "ok"],
    ["fails a change one line over across two files", [d(A, 300), d(B, 101)], undefined, "over"],
    ["never blocks a lone test file at any size", [d(A, 900)], undefined, "single-file"],
    ["does not credit deleted lines", [d(A, 450), d(B, -100)], undefined, "deletes"],
    ["does not let deleted lines pull an over-limit change under", [d(A, 300), d(B, 150), d(C, -100)], undefined, "over"],
    ["fails a change that only deletes test lines", [d(A, -60)], undefined, "deletes"],
    ["fails a small change that deletes test lines elsewhere", [d(A, 30), d(B, -60)], undefined, "deletes"],
    ["passes a deletion inside its allowance", [d(A, 30), d(B, -60)], { ...ROW, lines: 60 }, "allowed"],
    ["fails a deletion past its allowance", [d(A, 30), d(B, -61)], { ...ROW, lines: 60 }, "deletes"],
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
      "  to pass: write 48 fewer test lines, or ask the lead",
      `  for a row in ${ALLOWANCE_FILE}`,
    ]);
    const allowed = judge([d(A, 290), d(B, 158)], { allowance: ROW });
    NodeAssert.match(budgetLines(allowed)[0], /allowed 448 of 480 by Poteto: two tests replace/);
  });

  NodeTest.it("names the deleted lines and the row that would excuse them", () => {
    const result = judge([d(A, 30), d(B, -60), d(C, -5)]);
    NodeAssert.deepEqual(budgetLines(result), [
      "FAIL test budget: feat/x deletes 65 test lines in 2 files, they earn no budget (+30 added in 1 file)",
      `  -60 ${B}`,
      `  -5 ${C}`,
      `  to pass: keep the tests, or ask the lead for a row in ${ALLOWANCE_FILE} that names 65 lines`,
    ]);
    NodeAssert.equal(result.deleted, 65);
    NodeAssert.equal(result.net, 30);
  });

  NodeTest.it("says an over-limit change also deletes lines, and an allowed one what it deleted", () => {
    const over = budgetLines(judge([d(A, 290), d(B, 158), d(C, -90)]));
    NodeAssert.match(over[0], /^FAIL test budget: feat\/x \+448 net test lines in 2 files, limit 400, over by 48/);
    NodeAssert.ok(over.includes("  deletes 90 test lines, they earn no budget"));
    const allowed = budgetLines(judge([d(A, 30), d(B, -60)], { allowance: { ...ROW, lines: 60 } }));
    NodeAssert.match(allowed[0], /allowed 30 of 60 by Poteto: two tests replace.*deletes 60 test lines/);
  });
});

NodeTest.describe("the allowance rows a change adds", () => {
  NodeTest.it("takes only rows present at head and absent at base, with the base's limit", () => {
    const old = { ...ROW, change: "fix/old" };
    const found = newAllowances(file([old], 300), file([old, ROW], 9000));
    NodeAssert.deepEqual(found, { limit: 300, enforce: false, rows: [ROW], problems: [] });
    NodeAssert.deepEqual(newAllowances(null, null), {
      limit: 400,
      enforce: false,
      rows: [],
      problems: [],
    });
  });

  NodeTest.it(
    "reads enforce from the base file only, and refuses a value that is not a boolean",
    () => {
      NodeAssert.equal(newAllowances(file([], 400, true), file([])).enforce, true);
      NodeAssert.equal(newAllowances(file([]), file([], 400, true)).enforce, false);
      NodeAssert.match(
        newAllowances(null, '{"enforce":"yes","allowances":[]}').problems.join(),
        /enforce must be true or false/,
      );
    },
  );

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

function withRepo(run, { enforce = true } = {}) {
  const dir = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "test-budget-"));
  const repo = NodePath.join(dir, "repo");
  NodeFS.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "trunk");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  write(repo, A, body(10, "a"));
  write(repo, B, body(10, "b"));
  if (enforce) write(repo, ALLOWANCE_FILE, file([], undefined, true));
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
  const plan = (edit, options) => {
    let result;
    withRepo(({ repo, trunk }) => {
      branch(repo, "feat/x", () => edit(repo));
      result = cli(repo, trunk, "feat/x");
    }, options);
    return result;
  };
  const OFF = { enforce: false };

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
      write(repo, ALLOWANCE_FILE, file([{ ...ROW, lines: 9000 }], undefined, true));
      const base = commit(repo, "an earlier change's row lands on trunk");
      branch(repo, "feat/later", () => big(repo));
      NodeAssert.equal(cli(repo, base, "feat/later").code, 2);
    }),
  );

  NodeTest.it("does not let the lines a change deletes pay for the lines it adds", () =>
    withRepo(({ repo }) => {
      write(repo, B, body(300, "b"));
      const base = commit(repo, "a longer test lands on trunk");
      branch(repo, "fix/swap", () => {
        write(repo, A, body(460, "a"));
        write(repo, B, body(100, "b"));
      });
      const result = cli(repo, base, "fix/swap");
      NodeAssert.equal(result.code, 2);
      NodeAssert.match(
        result.err,
        /fix\/swap deletes 200 test lines in 1 file, they earn no budget \(\+450 added in 1 file\)/,
      );
      NodeAssert.match(result.err, /-200 scripts\/personal\/node\/test\/b\.test\.mjs/);
    }),
  );

  NodeTest.it("exits 2 for a deleted test file in enforce, and only reports it otherwise", () => {
    const drop = (repo) => NodeFS.rmSync(NodePath.join(repo, B));
    const enforced = plan(drop);
    NodeAssert.equal(enforced.code, 2);
    NodeAssert.match(enforced.err, /FAIL test budget: feat\/x deletes 10 test lines in 1 file, they earn no budget/);
    const reported = plan(drop, OFF);
    NodeAssert.equal(reported.code, 0, reported.err);
    NodeAssert.match(reported.err, /deletes 10 test lines/);
    NodeAssert.match(reported.err, /report mode, this does not block the release/);
  });

  NodeTest.it("lets a deleted test file through on a row it adds that names the lines", () => {
    const row = { ...ROW, lines: 10 };
    const drop = (repo) => {
      NodeFS.rmSync(NodePath.join(repo, B));
      write(repo, ALLOWANCE_FILE, file([row], undefined, true));
    };
    const allowed = plan(drop);
    NodeAssert.equal(allowed.code, 0, allowed.err);
    NodeAssert.match(allowed.out, /allowed 0 of 10 by Poteto.*deletes 10 test lines/);
    const short = plan((repo) => {
      NodeFS.rmSync(NodePath.join(repo, B));
      write(repo, ALLOWANCE_FILE, file([{ ...row, lines: 9 }], undefined, true));
    });
    NodeAssert.equal(short.code, 2);
  });

  NodeTest.it("only reports a change over the limit while the file does not say enforce", () => {
    const over = plan((repo) => big(repo), OFF);
    NodeAssert.equal(over.code, 0, over.err);
    NodeAssert.match(
      over.err,
      /FAIL test budget: feat\/x \+480 net test lines in 2 files, limit 400, over by 80/,
    );
    NodeAssert.match(over.err, /report mode, this does not block the release/);
    const bad = plan((repo) => write(repo, ALLOWANCE_FILE, "{ nope"), OFF);
    NodeAssert.equal(bad.code, 0, bad.err);
    NodeAssert.match(bad.err, /not valid JSON.*\n.*report mode/s);
  });

  NodeTest.it("takes enforce from where the change left trunk, never from the change", () => {
    const turnsOn = plan((repo) => big(repo, { [ALLOWANCE_FILE]: file([], undefined, true) }), OFF);
    NodeAssert.equal(turnsOn.code, 0, turnsOn.err);
    const turnsOff = plan((repo) => big(repo, { [ALLOWANCE_FILE]: file([], undefined, false) }));
    NodeAssert.equal(turnsOff.code, 2);
  });

  NodeTest.it("exits 2 on an allowance file it cannot read, even for a small change", () => {
    const bad = plan((repo) => big(repo, { [ALLOWANCE_FILE]: "{ nope" }));
    NodeAssert.equal(bad.code, 2);
    const small = plan((repo) => write(repo, ALLOWANCE_FILE, "{ nope"));
    NodeAssert.equal(small.code, 2);
    NodeAssert.match(small.err, /FAIL test budget: allowance file at head is not valid JSON/);
  });

  NodeTest.it("counts a renamed test file as lines gained and lines deleted", () =>
    withRepo(({ repo }) => {
      write(repo, A, body(600, "a"));
      const base = commit(repo, "a long test lands on trunk");
      branch(repo, "feat/move", () => {
        git(repo, "mv", A, C);
        write(repo, C, body(1050, "a"));
        write(repo, B, body(210, "b"));
      });
      const result = cli(repo, base, "feat/move");
      NodeAssert.equal(result.code, 2);
      NodeAssert.match(result.err, /feat\/move \+1250 net test lines in 2 files/);
      NodeAssert.match(result.err, /deletes 600 test lines, they earn no budget/);
    }),
  );

  NodeTest.it("counts Kotlin tests, and a file that nets to zero is not a second file", () => {
    const kotlin = (name) => `apps/hbots-mobile/modules/camera/android/src/test/java/${name}.kt`;
    const kt = plan((repo) => {
      write(repo, kotlin("One"), body(250, "k"));
      write(repo, kotlin("Two"), body(200, "k"));
    });
    NodeAssert.equal(kt.code, 2);
    NodeAssert.match(kt.err, /\+450 net test lines in 2 files/);
    const lone = plan((repo) => {
      write(repo, A, body(900, "a"));
      write(repo, B, body(10, "swapped"));
    });
    NodeAssert.equal(lone.code, 0, lone.err);
    NodeAssert.match(lone.out, /\+890 net test lines in 1 file .*single-file/);
  });
});

NodeTest.describe("the release walk", () => {
  const merge = (repo, name) =>
    git(repo, "merge", "--no-ff", "-q", "-m", `Merge branch '${name}'`, name);
  const head = (repo) => git(repo, "rev-parse", "HEAD");

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

  NodeTest.it("keeps an over-limit merge as a warning, not a problem, in report mode", () =>
    withRepo(
      ({ repo, trunk }) => {
        branch(repo, "feat/big", () => big(repo));
        merge(repo, "feat/big");
        const report = budgetOfRelease(repo, trunk, head(repo));
        NodeAssert.deepEqual(report.problems, []);
        NodeAssert.match(
          report.warnings.join("\n"),
          /FAIL test budget: feat\/big \+480[^]*report mode/,
        );
      },
      { enforce: false },
    ),
  );

  NodeTest.it(
    "measures commits made straight on the line against the limit they started from",
    () =>
      withRepo(({ repo, trunk }) => {
        write(repo, ALLOWANCE_FILE, file([], 9000, true));
        commit(repo, "one commit raises the limit");
        big(repo);
        commit(repo, "then the tests arrive");
        const found = budgetOfRelease(repo, trunk, head(repo));
        NodeAssert.match(
          found.problems.join(),
          /release line \+480 net test lines in 2 files, limit 400/,
        );
      }),
  );

  NodeTest.it("measures an octopus merge as one change", () =>
    withRepo(({ repo, trunk }) => {
      branch(repo, "feat/one", () => write(repo, C, body(250, "c")));
      branch(repo, "feat/two", () => write(repo, A, body(250, "a")));
      git(
        repo,
        "merge",
        "--no-ff",
        "-q",
        "-m",
        "Merge feat/one and feat/two",
        "feat/one",
        "feat/two",
      );
      const found = budgetOfRelease(repo, trunk, head(repo));
      NodeAssert.match(found.problems.join(), /merge [0-9a-f]{10} \+490 net test lines in 2 files/);
    }),
  );

  NodeTest.it(
    "counts lines added while resolving a merge",
    { todo: "known gap: a merge commit's own lines are not counted" },
    () =>
      withRepo(({ repo, trunk }) => {
        branch(repo, "feat/small", () => write(repo, C, body(10, "c")));
        git(repo, "merge", "--no-ff", "--no-commit", "feat/small");
        big(repo);
        git(repo, "commit", "-q", "-m", "Merge branch 'feat/small'");
        NodeAssert.equal(budgetOfRelease(repo, trunk, head(repo)).problems.length, 1);
      }),
  );

  const seal = ({ repo, trunk, dir }, release) => {
    NodeFS.writeFileSync(NodePath.join(dir, "current.txt"), `${trunk}\n`);
    NodeTest.mock.method(console, "error", () => {});
    const all = planEvidenceProblems(
      { currentTxt: NodePath.join(dir, "current.txt") },
      { "repo-root": repo, release },
      { gates: [] },
    );
    const warned = console.error.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    NodeTest.mock.restoreAll();
    return { problems: all.filter((problem) => /test budget/.test(problem)), warned };
  };
  const mergeAndBreak = (context) => {
    branch(context.repo, "feat/x", () => write(context.repo, A, body(30, "a")));
    merge(context.repo, "feat/x");
    const blob = git(context.repo, "rev-parse", `HEAD:${A}`);
    NodeFS.rmSync(NodePath.join(context.repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    return seal(context, head(context.repo));
  };

  NodeTest.it(
    "makes the seal fail closed when the budget cannot be computed and enforce is on",
    () =>
      withRepo((context) =>
        NodeAssert.match(mergeAndBreak(context).problems.join(), /cannot compute the test budget/),
      ),
  );

  NodeTest.it("makes the seal warn loudly, not block, when the budget crashes in report mode", () =>
    withRepo(
      (context) => {
        const { problems, warned } = mergeAndBreak(context);
        NodeAssert.deepEqual(problems, []);
        NodeAssert.match(warned, /WARNING: the test budget guard crashed/);
      },
      { enforce: false },
    ),
  );

  NodeTest.it(
    "prints the report and records no problem for an over-limit merge in report mode",
    () =>
      withRepo(
        (context) => {
          branch(context.repo, "feat/big", () => big(context.repo));
          merge(context.repo, "feat/big");
          const { problems, warned } = seal(context, head(context.repo));
          NodeAssert.deepEqual(problems, []);
          NodeAssert.match(warned, /FAIL test budget: feat\/big \+480[^]*report mode/);
        },
        { enforce: false },
      ),
  );
});
