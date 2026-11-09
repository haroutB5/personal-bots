import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  compareCoverage,
  findShards,
  isOwnAmbient,
  leanSettings,
  resolveCatalogTsc,
  splitBlocks,
} from "../lib/typecheck.mjs";

NodeTest.test("lean is the default: one checker and GOGC=25", () => {
  NodeAssert.deepEqual(leanSettings({}), {
    lean: true,
    env: { GOGC: "25" },
    args: ["--checkers", "1"],
  });
});

NodeTest.test("HBOTS_TYPECHECK=full is the kill switch back to plain tsc", () => {
  NodeAssert.equal(leanSettings({ HBOTS_TYPECHECK: "full" }).lean, false);
  NodeAssert.throws(() => leanSettings({ HBOTS_TYPECHECK: "fast" }), /lean or full/);
});

NodeTest.test("a caller's GOGC and checker count win", () => {
  const s = leanSettings({ GOGC: "50", HBOTS_TYPECHECK_CHECKERS: "2" });
  NodeAssert.deepEqual(s.env, {});
  NodeAssert.deepEqual(s.args, ["--checkers", "2"]);
  NodeAssert.throws(() => leanSettings({ HBOTS_TYPECHECK_CHECKERS: "0" }), /1-99/);
});

NodeTest.test("diagnostic blocks keep their continuation lines", () => {
  const text = "a.ts(1,1): error TS2322: x\n  detail one\nb.ts(2,2): error TS1: y\n\n";
  NodeAssert.deepEqual(splitBlocks(text), [
    "a.ts(1,1): error TS2322: x\n  detail one",
    "b.ts(2,2): error TS1: y",
  ]);
});

NodeTest.test("coverage reports files the shards miss or add", () => {
  NodeAssert.deepEqual(compareCoverage(["a", "b", "c"], [["a"], ["b", "c"]]), {
    missing: [],
    extra: [],
  });
  NodeAssert.deepEqual(compareCoverage(["a", "b"], [["a"], ["x"]]), {
    missing: ["b"],
    extra: ["x"],
  });
});

NodeTest.test("shards are the sorted tsconfig.typecheck-*.json files", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-tc-"));
  try {
    for (const f of [
      "tsconfig.json",
      "tsconfig.typecheck-tests.json",
      "tsconfig.typecheck-app.json",
      "tsconfig.typecheck-x.txt",
    ]) {
      NodeFS.writeFileSync(NodePath.join(dir, f), "{}");
    }
    NodeAssert.deepEqual(findShards(dir), [
      "tsconfig.typecheck-app.json",
      "tsconfig.typecheck-tests.json",
    ]);
  } finally {
    NodeFS.rmSync(dir, { recursive: true });
  }
});

NodeTest.test("the lean typecheck resolves the catalog TypeScript, not a hoisted bin", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-tc-"));
  const tsc = NodePath.join(
    root,
    "node_modules",
    ".pnpm",
    "typescript@7.0.2",
    "node_modules",
    "typescript",
    "lib",
    "tsc.js",
  );
  try {
    NodeFS.mkdirSync(NodePath.dirname(tsc), { recursive: true });
    NodeFS.writeFileSync(tsc, "");
    NodeFS.writeFileSync(
      NodePath.join(root, "pnpm-workspace.yaml"),
      "catalog:\n  typescript: 7.0.2\n\noverrides:\n  typescript: 6.0.3\n",
    );
    NodeAssert.equal(resolveCatalogTsc({ repoRoot: root }), tsc);
  } finally {
    NodeFS.rmSync(root, { recursive: true });
  }
});

NodeTest.test("the catalog resolver refuses a missing or ranged TypeScript pin", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-tc-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(root, "pnpm-workspace.yaml"),
      "catalog:\n  typescript: ~7.0.2\n",
    );
    NodeAssert.throws(() => resolveCatalogTsc({ repoRoot: root }), /exact typescript version/);
    NodeFS.writeFileSync(
      NodePath.join(root, "pnpm-workspace.yaml"),
      "catalog:\n  typescript: 7.0.2\n",
    );
    NodeAssert.throws(() => resolveCatalogTsc({ repoRoot: root }), /not installed/);
  } finally {
    NodeFS.rmSync(root, { recursive: true });
  }
});

NodeTest.test("own .d.ts files and global or module augmentations must be in every shard", () => {
  const src = {
    "/r/src/a.ts": 'declare module "@tanstack/react-router" {\n}',
    "/r/src/b.ts": "  declare global {\n}",
    "/r/src/c.ts": "export const declare = 1; // declare global",
  };
  const read = (f) => src[f] ?? "";
  NodeAssert.equal(isOwnAmbient("/r/src/a.ts", read), true);
  NodeAssert.equal(isOwnAmbient("/r/src/b.ts", read), true);
  NodeAssert.equal(isOwnAmbient("/r/src/c.ts", read), false);
  NodeAssert.equal(isOwnAmbient("/r/src/vite-env.d.ts", read), true);
  NodeAssert.equal(isOwnAmbient("/r/node_modules/x/index.d.ts", read), false);
  NodeAssert.equal(isOwnAmbient("bundled:///libs/lib.dom.d.ts", read), false);
});
