// The verification stamp: the pure rules, then the planner command over real commits.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { branch, commit, git, planner, withRepo, write } from "./scratchRepo.mjs";
import {
  DEFAULT_MODE,
  STAMP_MODE_FILE,
  isReleaseCommit,
  judgeStamps,
  readMode,
  readStamp,
  stampLines,
} from "../lib/verifyStamp.mjs";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { stampOfRange } from "../lib/gateScope.mjs";
import { planEvidenceProblems } from "../lib/seal.mjs";

const mode = (value) => JSON.stringify({ mode: value });
const sha = (n) => `${String(n).repeat(40)}`.slice(0, 40);
const c = (n, extra = {}) => ({
  sha: sha(n),
  parents: 1,
  subject: `change ${n}`,
  paths: [],
  trailers: [],
  ...extra,
});

NodeTest.describe("the mode file", () => {
  NodeTest.it("defaults to observe when the file is missing", () => {
    NodeAssert.equal(DEFAULT_MODE, "observe");
    NodeAssert.deepEqual(readMode(null), { mode: "observe" });
  });

  for (const value of ["off", "observe", "enforce"])
    NodeTest.it(`reads ${value}`, () => NodeAssert.deepEqual(readMode(mode(value)), { mode: value }));

  const bad = [
    ["invalid JSON", "{ nope", /is not valid JSON/],
    ["an unknown mode", mode("block"), /mode must be one of off, observe, enforce/],
    ["no mode", "{}", /mode must be one of off, observe, enforce/],
    ["a list", "[]", /mode must be one of off, observe, enforce/],
  ];
  for (const [name, source, pattern] of bad)
    NodeTest.it(`falls back to observe with a warning for ${name}`, () => {
      const read = readMode(source);
      NodeAssert.equal(read.mode, "observe");
      NodeAssert.match(read.warning, pattern);
      NodeAssert.match(read.warning, new RegExp(STAMP_MODE_FILE.replaceAll(".", "\\.")));
    });
});

NodeTest.describe("one stamp", () => {
  const table = [
    ["free text", ["e2e rig daily-use 3/3"], { kind: "verified", how: "e2e rig daily-use 3/3" }],
    ["none with a reason", ["none (docs only)"], { kind: "none", reason: "docs only" }],
    ["none with no reason", ["none"], { kind: "missing" }],
    ["none with empty parentheses", ["none ()"], { kind: "missing" }],
    ["an empty value", ["   "], { kind: "missing" }],
    ["no trailer", [], { kind: "missing" }],
    ["a bad one then a good one", ["none", "ran the suite"], { kind: "verified", how: "ran the suite" }],
  ];
  for (const [name, values, stamp] of table)
    NodeTest.it(`reads ${name}`, () => NodeAssert.deepEqual(readStamp(values), stamp));
});

NodeTest.describe("the release commits", () => {
  const version = ["apps/hbots-mobile/package.json", "scripts/personal/app-version.txt"];
  NodeTest.it("exempts a version commit and a notes commit by subject and paths", () => {
    NodeAssert.ok(isReleaseCommit({ subject: "chore(release): hbots 1.67.35", paths: [...version, "docs/releases/HANDOFF-16735.md"] }));
    NodeAssert.ok(isReleaseCommit({ subject: "docs(release): hbots 1.67.35 gate evidence", paths: ["docs/releases/HANDOFF-16735.md"] }));
    NodeAssert.ok(isReleaseCommit({ subject: "chore(release): prepare v1.67.35", paths: ["scripts/personal/linux/hbots-release/PINS.json"] }));
  });
  NodeTest.it("does not exempt a release subject that carries code", () => {
    NodeAssert.equal(isReleaseCommit({ subject: "chore(release): hbots 1.67.35", paths: [...version, "apps/server/src/personal/x.ts"] }), false);
    NodeAssert.equal(isReleaseCommit({ subject: "feat(release): hbots 1.67.35", paths: version }), false);
    NodeAssert.equal(isReleaseCommit({ subject: "fix: something", paths: version }), false);
  });
});

NodeTest.describe("the verdict", () => {
  const stamped = (n, value) => c(n, { trailers: [value] });
  const commits = [
    c(1),
    stamped(2, "ran the suite"),
    stamped(3, "none (docs only)"),
    c(4, { parents: 2, subject: "Merge branch 'x'" }),
    c(5, { subject: "chore(release): hbots 1.0.0", paths: ["scripts/personal/app-version.txt"] }),
    c(6, { trailers: ["none"] }),
  ];

  NodeTest.it("counts unstamped commits of those that need a stamp", () => {
    const result = judgeStamps({ mode: { mode: "observe" }, commits });
    NodeAssert.equal(result.total, 4);
    NodeAssert.deepEqual(result.unstamped.map((commit) => commit.sha), [sha(1), sha(6)]);
    NodeAssert.equal(result.stampedNone, 1);
    NodeAssert.equal(result.exempt, 2);
    NodeAssert.equal(result.blocks, false);
  });

  NodeTest.it("prints the observe line and the sha list", () => {
    NodeAssert.deepEqual(stampLines(judgeStamps({ mode: { mode: "observe" }, commits })), [
      "verify stamp: 2 of 4 commits unstamped (observe, never blocks; 1 stamped none, 2 exempt)",
      `  ${sha(1).slice(0, 10)} change 1`,
      `  ${sha(6).slice(0, 10)} change 6`,
    ]);
  });

  NodeTest.it("blocks in enforce only when a commit is unstamped", () => {
    const enforced = judgeStamps({ mode: { mode: "enforce" }, commits });
    NodeAssert.equal(enforced.blocks, true);
    NodeAssert.match(stampLines(enforced)[0], /^FAIL verify stamp: 2 of 4 commits unstamped \(enforce; /);
    NodeAssert.equal(judgeStamps({ mode: { mode: "enforce" }, commits: commits.slice(1, 3) }).blocks, false);
  });

  NodeTest.it("says nothing in off mode and never blocks", () => {
    const off = judgeStamps({ mode: { mode: "off" }, commits });
    NodeAssert.deepEqual(stampLines(off), []);
    NodeAssert.equal(off.blocks, false);
  });

  NodeTest.it("carries the mode file warning into the lines", () => {
    const lines = stampLines(judgeStamps({ mode: { mode: "observe", warning: "scripts/x.json is not valid JSON" }, commits: [] }));
    NodeAssert.equal(lines[0], "WARNING: scripts/x.json is not valid JSON; observe mode");
    NodeAssert.match(lines[1], /^verify stamp: 0 of 0 commits unstamped/);
  });

  NodeTest.it("lists at most twenty shas and counts the rest", () => {
    const many = Array.from({ length: 23 }, (_, i) => c(i + 1));
    const lines = stampLines(judgeStamps({ mode: { mode: "observe" }, commits: many }));
    NodeAssert.equal(lines.length, 1 + 20 + 1);
    NodeAssert.equal(lines.at(-1), "  ... and 3 more");
  });
});

NodeTest.describe("the planner command over real commits", () => {
  const seed = (repo) => write(repo, "apps/web/src/a.ts", "export const a = 1;\n");
  const modeFile = (value) => (repo) => {
    seed(repo);
    write(repo, STAMP_MODE_FILE, typeof value === "string" ? value : mode(value.mode));
  };
  const edit = (repo, n, message) => {
    write(repo, "apps/web/src/a.ts", `export const a = ${n};\n`);
    return commit(repo, message);
  };
  const run = (setup, build, flags = []) => {
    let result;
    withRepo(setup, ({ repo, trunk }) => {
      git(repo, "checkout", "-q", "-b", "feat/x");
      const shas = build(repo);
      git(repo, "checkout", "-q", "trunk");
      result = { ...planner(repo, trunk, "feat/x", ...flags), shas };
    });
    return result;
  };
  const two = (repo) => [edit(repo, 2, "first change"), edit(repo, 3, "second change\n\nVerified: unit tests 3/3")];

  NodeTest.it("prints the observe line with the unstamped sha when the mode file is missing", () => {
    const result = run(seed, two);
    NodeAssert.equal(result.code, 0, result.err);
    NodeAssert.match(result.out, /verify stamp: 1 of 2 commits unstamped \(observe, never blocks/);
    NodeAssert.ok(result.out.includes(`  ${result.shas[0].slice(0, 10)} first change`));
    NodeAssert.ok(!result.out.includes(result.shas[1].slice(0, 10)));
  });

  NodeTest.it("goes to stderr with --commands so stdout stays commands only", () => {
    const stamped = run(
      (repo) => {
        seed(repo);
        write(repo, "scripts/personal/node/gates-linux.scoped.json", "[]\n");
      },
      two,
      ["--commands"],
    );
    NodeAssert.equal(stamped.code, 0, stamped.err);
    NodeAssert.match(stamped.err, /verify stamp: 1 of 2 commits unstamped/);
    NodeAssert.doesNotMatch(stamped.out, /verify stamp/);
  });

  NodeTest.it("clears the count for a stamped commit and for none with a reason", () => {
    const result = run(seed, (repo) => [
      edit(repo, 2, "first change\n\nVerified: none (comment only)"),
      edit(repo, 3, "second change\n\nVerified: e2e rig daily-use 3/3"),
    ]);
    NodeAssert.equal(result.code, 0, result.err);
    NodeAssert.match(result.out, /verify stamp: 0 of 2 commits unstamped \(observe, never blocks; 1 stamped none/);
  });

  NodeTest.it("exits 2 in enforce and names the commit", () => {
    const result = run(modeFile({ mode: "enforce" }), two);
    NodeAssert.equal(result.code, 2);
    NodeAssert.match(result.err, /FAIL verify stamp: 1 of 2 commits unstamped \(enforce; /);
    NodeAssert.ok(result.err.includes(result.shas[0].slice(0, 10)));
  });

  NodeTest.it("passes in enforce when every commit carries a stamp", () => {
    const result = run(modeFile({ mode: "enforce" }), (repo) => [
      edit(repo, 2, "first change\n\nVerified: none (comment only)"),
      edit(repo, 3, "second change\n\nVerified: ran the suite"),
    ]);
    NodeAssert.equal(result.code, 0, result.err);
    NodeAssert.match(result.out, /verify stamp: 0 of 2 commits unstamped/);
  });

  NodeTest.it("exempts a merge commit and a release version commit", () => {
    const result = run(modeFile({ mode: "enforce" }), (repo) => {
      const first = edit(repo, 2, "first change\n\nVerified: ran the suite");
      git(repo, "checkout", "-q", "-b", "side", "trunk");
      write(repo, "apps/web/src/b.ts", "export const b = 1;\n");
      commit(repo, "side change\n\nVerified: none (scratch)");
      git(repo, "checkout", "-q", "feat/x");
      git(repo, "merge", "--no-ff", "-q", "-m", "Merge branch 'side'", "side");
      write(repo, "scripts/personal/app-version.txt", "1.2.3\n");
      write(repo, "apps/hbots-mobile/package.json", "{}\n");
      const release = commit(repo, "chore(release): hbots 1.2.3");
      return [first, release];
    });
    NodeAssert.equal(result.code, 0, result.err);
    NodeAssert.match(result.out, /verify stamp: 0 of 2 commits unstamped \(enforce; 1 stamped none, 2 exempt\)/);
  });

  NodeTest.it("reads the mode from where the branch left trunk, never from the branch", () => {
    const turnsOn = run(seed, (repo) => {
      write(repo, STAMP_MODE_FILE, mode("enforce"));
      return [edit(repo, 2, "first change")];
    });
    NodeAssert.equal(turnsOn.code, 0, turnsOn.err);
    const turnsOff = run(modeFile({ mode: "enforce" }), (repo) => {
      write(repo, STAMP_MODE_FILE, mode("off"));
      return [edit(repo, 2, "first change")];
    });
    NodeAssert.equal(turnsOff.code, 2);
  });

  NodeTest.it("warns and observes on a malformed mode file, and says nothing when off", () => {
    const malformed = run(modeFile("{ nope"), two);
    NodeAssert.equal(malformed.code, 0, malformed.err);
    NodeAssert.match(malformed.out, /WARNING: scripts\/personal\/qa\/verify-stamp\.json is not valid JSON.*; observe mode/);
    NodeAssert.match(malformed.out, /verify stamp: 1 of 2 commits unstamped/);
    const off = run(modeFile({ mode: "off" }), two);
    NodeAssert.equal(off.code, 0, off.err);
    NodeAssert.doesNotMatch(off.out + off.err, /verify stamp/);
  });

  NodeTest.it("measures a release range the same way", () =>
    withRepo(seed, ({ repo, trunk }) => {
      branch(repo, "feat/x", () => write(repo, "apps/web/src/a.ts", "export const a = 9;\n"));
      git(repo, "merge", "--no-ff", "-q", "-m", "Merge branch 'feat/x'", "feat/x");
      const result = stampOfRange(repo, trunk, git(repo, "rev-parse", "HEAD"));
      NodeAssert.equal(result.total, 1);
      NodeAssert.equal(result.exempt, 1);
      NodeAssert.equal(result.unstamped.length, 1);
    }),
  );

  const seal = (setup) => {
    let problems;
    withRepo(setup, ({ repo, trunk, dir }) => {
      branch(repo, "feat/x", () => write(repo, "apps/web/src/a.ts", "export const a = 9;\n"));
      git(repo, "merge", "--no-ff", "-q", "-m", "Merge branch 'feat/x'", "feat/x");
      NodeFS.writeFileSync(NodePath.join(dir, "current.txt"), `${trunk}\n`);
      problems = planEvidenceProblems(
        { currentTxt: NodePath.join(dir, "current.txt") },
        { "repo-root": repo, release: git(repo, "rev-parse", "HEAD") },
        { gates: [] },
      ).filter((problem) => /verify stamp|verify stamps/.test(problem));
    });
    return problems;
  };

  NodeTest.it("makes the seal refuse an unstamped commit in enforce, and only in enforce", () => {
    NodeAssert.match(seal(modeFile({ mode: "enforce" })).join(" "), /verify stamp: 1 of 1 commits unstamped in enforce mode/);
    NodeAssert.deepEqual(seal(seed), []);
    NodeAssert.deepEqual(seal(modeFile({ mode: "off" })), []);
  });
});
