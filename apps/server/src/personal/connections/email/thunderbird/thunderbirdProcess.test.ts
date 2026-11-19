import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { findThunderbirdPids } from "./thunderbirdProcess.ts";

const proc = (entries: Readonly<Record<string, ReadonlyArray<string>>>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-proc-"));
  for (const [pid, argv] of Object.entries(entries)) {
    NodeFS.mkdirSync(NodePath.join(root, pid));
    NodeFS.writeFileSync(NodePath.join(root, pid, "cmdline"), `${argv.join("\0")}\0`);
  }
  return root;
};

describe("findThunderbirdPids", () => {
  it("finds the main process and ignores content children and look-alikes", () => {
    const root = proc({
      "100": ["/home/h/.local/opt/thunderbird/thunderbird-bin", "-P", "hbots-mail"],
      "101": ["/home/h/.local/opt/thunderbird/thunderbird-bin", "-contentproc", "x"],
      "102": ["vim", "thunderbird.txt"],
      "103": ["bash", "-c", "thunderbird -P hbots-mail"],
    });
    try {
      expect(findThunderbirdPids(root)).toEqual([100]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds nothing in a folder that does not exist", () => {
    expect(findThunderbirdPids("/nonexistent-proc-root")).toEqual([]);
  });
});
