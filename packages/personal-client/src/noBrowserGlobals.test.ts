// @effect-diagnostics nodeBuiltinImport:off -- This guard reads the package source from disk to scan it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

const SOURCE_ROOT = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const EXEMPT = new Set(["noDom.type-test.ts", "noBrowserGlobals.test.ts"]);
const BANNED = new Set(["localStorage", "sessionStorage", "window", "document"]);

/** @types/node declares localStorage, so tsc cannot catch it. This scan is the only guard. */
function bannedGlobalsIn(source: string): ReadonlyArray<string> {
  const found: string[] = [];
  let index = 0;
  const skipQuoted = (quote: string) => {
    index += 1;
    while (index < source.length && source[index] !== quote) {
      index += source[index] === "\\" ? 2 : 1;
    }
    index += 1;
  };
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      skipQuoted(char);
    } else if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      while (index < source.length && /[\w$]/.test(source[index] as string)) index += 1;
      const word = source.slice(start, index);
      if (BANNED.has(word)) found.push(word);
    } else {
      index += 1;
    }
  }
  return found;
}

function sourceFiles(directory: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !EXEMPT.has(entry.name) ? [path] : [];
  });
}

describe("browser globals stay out of the package", () => {
  it("finds a banned name in code and ignores it in comments and strings", () => {
    expect(bannedGlobalsIn("const a = globalThis.localStorage;")).toEqual(["localStorage"]);
    expect(bannedGlobalsIn("if (typeof window === 'undefined') document.title;")).toEqual([
      "window",
      "document",
    ]);
    expect(
      bannedGlobalsIn('// window\n/* sessionStorage */ const k = "document"; `window`'),
    ).toEqual([]);
  });

  it("finds none in packages/personal-client/src", () => {
    const hits = sourceFiles(SOURCE_ROOT).flatMap((path) =>
      bannedGlobalsIn(NodeFS.readFileSync(path, "utf8")).map(
        (name) => `${NodePath.relative(SOURCE_ROOT, path)}: ${name}`,
      ),
    );
    expect(hits).toEqual([]);
  });
});
