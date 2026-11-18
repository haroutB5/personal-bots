import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { branch, git, ROOT, withRepo, write } from "./scratchRepo.mjs";

const REPO_ROOT = NodePath.join(ROOT, "../../../..");
const MATCHER = NodePath.join(REPO_ROOT, "scripts/personal/qa/review-match.py");
const CHECKLIST = NodePath.join(REPO_ROOT, "docs/personal/REVIEW.md");
const APK_CHECK = "apps/hbots-mobile/scripts/verify-apk.mjs";

const matched = (touch) => {
  let line;
  withRepo(
    (repo) => {
      write(repo, APK_CHECK, 'const expectedExported = ["a"];\n');
      write(repo, "apps/web/src/a.ts", "export const a = 1;\n");
    },
    ({ repo, trunk }) => {
      branch(repo, "feat/x", () => touch(repo));
      const out = NodeChildProcess.execFileSync(
        "python3",
        ["-I", MATCHER, CHECKLIST, repo, trunk, "feat/x"],
        { encoding: "utf8" },
      );
      line = out.split("\n").find((entry) => entry.startsWith("Matched:"));
    },
  );
  return line;
};

NodeTest.describe("the hbots review checklist matcher", () => {
  NodeTest.it("matches R12 on a diff that grows the APK allowlist", () => {
    const line = matched((repo) => write(repo, APK_CHECK, 'const expectedExported = ["a", "b"];\n'));
    NodeAssert.match(line, /\bR12\b/);
  });

  NodeTest.it("does not match R12 on a diff that leaves the APK check alone", () => {
    const line = matched((repo) => write(repo, "apps/web/src/a.ts", "export const a = 2;\n"));
    NodeAssert.doesNotMatch(line, /\bR12\b/);
  });
});
