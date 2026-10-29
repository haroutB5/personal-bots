import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { existingRootFor, randomRoot, ROOT_PREFIX } from "../throwaway.mjs";

function uniqueName(label) {
  return `${label}-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 100)}`;
}

test("a throwaway root carries a random suffix instead of the predictable name", () => {
  const name = uniqueName("root");
  const root = randomRoot(name);
  assert.equal(path.dirname(root), os.tmpdir());
  assert.match(path.basename(root), new RegExp(`^${ROOT_PREFIX}${name}-[0-9a-f]{8}$`));
  assert.notEqual(root, path.join(os.tmpdir(), ROOT_PREFIX + name));
  assert.notEqual(randomRoot(name), root, "two starts never share a path");
});

test("a later command finds the root through its record, not by guessing the path", (t) => {
  const name = uniqueName("lookup");
  const root = randomRoot(name);
  fs.mkdirSync(root, { recursive: true });
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(existingRootFor(name), null, "an unrecorded root is not this name's");
  fs.writeFileSync(
    path.join(root, "throwaway.json"),
    `${JSON.stringify({ name, root, port: 1, pid: 1 })}\n`,
  );
  assert.equal(existingRootFor(name), root);
  assert.equal(existingRootFor(`${name}-other`), null, "names are matched exactly");
});

test("the old predictable path is never taken for a name with no record", () => {
  const name = uniqueName("predictable");
  assert.equal(existingRootFor(name), null);
});
