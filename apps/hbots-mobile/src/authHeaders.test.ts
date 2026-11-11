import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SRC_ROOT = NodeURL.fileURLToPath(new URL("./", import.meta.url));
const SIGNER = "authorizedRequest.ts";
const HAND_BUILT_HEADER = /`(?:Bearer|DPoP) \$\{/;

function sourceFiles(directory: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const isSource = /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name);
    return isSource ? [path] : [];
  });
}

describe("authorization headers", () => {
  it("are built in authorizedRequest.ts and nowhere else", () => {
    const files = sourceFiles(SRC_ROOT);
    expect(files.some((path) => NodePath.basename(path) === SIGNER)).toBe(true);

    const offenders = files
      .filter((path) => NodePath.basename(path) !== SIGNER)
      .filter((path) => HAND_BUILT_HEADER.test(NodeFS.readFileSync(path, "utf8")))
      .map((path) => NodePath.relative(SRC_ROOT, path));

    expect(offenders).toEqual([]);
  });
});
