// @effect-diagnostics nodeBuiltinImport:off - evaluates the worker's own file reader against real files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { READ_TEXT_SOURCE } from "./stallWatchdogWorker.ts";

const readText = new Function("fs", "Buffer", `${READ_TEXT_SOURCE}; return readText;`)(
  NodeFS,
  Buffer,
) as (file: string) => string | null;

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stall-read-text-"));
const write = (name: string, bytes: number) => {
  const file = NodePath.join(dir, name);
  NodeFS.writeFileSync(file, "x".repeat(bytes));
  return file;
};

afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

describe("the worker's file reader", () => {
  it("returns a file of up to 8 KiB whole", () => {
    expect(readText(write("small", 102))).toBe("x".repeat(102));
    expect(readText(write("limit", 8192))?.length).toBe(8192);
  });

  it("gives null for a longer file instead of handing it to the main thread", () => {
    expect(readText(write("long", 8193))).toBeNull();
    expect(readText(write("huge", 13_000_000))).toBeNull();
  });

  it("gives null for a file it cannot open", () => {
    expect(readText(NodePath.join(dir, "missing"))).toBeNull();
  });
});
