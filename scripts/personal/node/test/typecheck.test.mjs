import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareCoverage, findShards, leanSettings, splitBlocks } from "../lib/typecheck.mjs";

test("lean is the default: one checker and GOGC=25", () => {
  assert.deepEqual(leanSettings({}), {
    lean: true,
    env: { GOGC: "25" },
    args: ["--checkers", "1"],
  });
});

test("HBOTS_TYPECHECK=full is the kill switch back to plain tsc", () => {
  assert.equal(leanSettings({ HBOTS_TYPECHECK: "full" }).lean, false);
  assert.throws(() => leanSettings({ HBOTS_TYPECHECK: "fast" }), /lean or full/);
});

test("a caller's GOGC and checker count win", () => {
  const s = leanSettings({ GOGC: "50", HBOTS_TYPECHECK_CHECKERS: "2" });
  assert.deepEqual(s.env, {});
  assert.deepEqual(s.args, ["--checkers", "2"]);
  assert.throws(() => leanSettings({ HBOTS_TYPECHECK_CHECKERS: "0" }), /1-99/);
});

test("diagnostic blocks keep their continuation lines", () => {
  const text = "a.ts(1,1): error TS2322: x\n  detail one\nb.ts(2,2): error TS1: y\n\n";
  assert.deepEqual(splitBlocks(text), [
    "a.ts(1,1): error TS2322: x\n  detail one",
    "b.ts(2,2): error TS1: y",
  ]);
});

test("coverage reports files the shards miss or add", () => {
  assert.deepEqual(compareCoverage(["a", "b", "c"], [["a"], ["b", "c"]]), {
    missing: [],
    extra: [],
  });
  assert.deepEqual(compareCoverage(["a", "b"], [["a"], ["x"]]), { missing: ["b"], extra: ["x"] });
});

test("shards are the sorted tsconfig.typecheck-*.json files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hbots-tc-"));
  try {
    for (const f of [
      "tsconfig.json",
      "tsconfig.typecheck-tests.json",
      "tsconfig.typecheck-app.json",
      "tsconfig.typecheck-x.txt",
    ]) {
      fs.writeFileSync(path.join(dir, f), "{}");
    }
    assert.deepEqual(findShards(dir), [
      "tsconfig.typecheck-app.json",
      "tsconfig.typecheck-tests.json",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
