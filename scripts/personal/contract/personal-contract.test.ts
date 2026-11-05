// Contract golden for the personal RPC surface. Run:
//   node --test scripts/personal/contract/personal-contract.test.ts
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { test } from "node:test";
import * as NodeURL from "node:url";

import {
  buildPersonalContractSnapshot,
  diffPersonalContract,
  parsePersonalContract,
  serializePersonalContract,
  type PersonalContractSnapshot,
} from "../../../packages/contracts/src/personalContractSnapshot.ts";

const GOLDEN_PATH = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "personal-contract.golden.json",
);

const readGolden = (): PersonalContractSnapshot =>
  parsePersonalContract(JSON.parse(NodeFS.readFileSync(GOLDEN_PATH, "utf8")));

const clone = (snapshot: PersonalContractSnapshot): PersonalContractSnapshot =>
  JSON.parse(JSON.stringify(snapshot)) as PersonalContractSnapshot;

const entry = (snapshot: PersonalContractSnapshot, tag: string) => {
  const found = snapshot.entries.find((candidate) => candidate.tag === tag);
  assert.ok(found, `missing entry ${tag}`);
  return found;
};

test("checked-in golden matches the live personal contract", () => {
  const diffs = diffPersonalContract(readGolden(), buildPersonalContractSnapshot());
  assert.deepEqual(diffs, []);
});

test("golden is deterministic across builds", () => {
  assert.equal(
    serializePersonalContract(buildPersonalContractSnapshot()),
    serializePersonalContract(buildPersonalContractSnapshot()),
  );
});

test("covers every personal method plus the two server methods the client calls", () => {
  const golden = readGolden();
  const tags = golden.entries.map((candidate) => candidate.tag);
  assert.equal(tags.length, 136);
  assert.equal(new Set(tags).size, 136);
  assert.deepEqual(tags, [...tags].sort());
  for (const tag of ["server.getConfig", "server.refreshProviders", "personalBots.list"]) {
    assert.ok(tags.includes(tag), `missing ${tag}`);
  }
});

test("a changed personal field fails with the exact method and field path", () => {
  const golden = readGolden();
  const changed = clone(golden);
  const payload = entry(changed, "personalBots.list").payload as {
    properties: { omitArchived: { anyOf: Array<{ type: string }> } };
  };
  payload.properties.omitArchived.anyOf[0]!.type = "string";

  assert.deepEqual(diffPersonalContract(golden, changed), [
    {
      path: "personalBots.list/payload/properties/omitArchived/anyOf/0/type",
      kind: "changed",
      expected: "boolean",
      actual: "string",
    },
  ]);
});

test("a removed personal method fails as missing", () => {
  const golden = readGolden();
  const changed = clone(golden);
  const without = changed.entries.filter((candidate) => candidate.tag !== "personalGroups.stop");
  const missing = { entries: without };

  assert.deepEqual(diffPersonalContract(golden, missing), [
    {
      path: "personalGroups.stop",
      kind: "missing",
      expected: entry(golden, "personalGroups.stop"),
      actual: undefined,
    },
  ]);
});
