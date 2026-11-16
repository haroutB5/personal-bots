import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const SRC = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@tabler/icons-react-native";

function sourceFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir).flatMap((name) => {
    const path = NodePath.join(dir, name);
    if (NodeFS.statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}

describe("icon imports", () => {
  it("never import the package barrel, which loads all 6,151 icon files at launch", () => {
    const barrel = new RegExp(`from\\s+["']${PACKAGE}["']`, "u");
    const offenders = sourceFiles(SRC)
      .filter((path) => !path.endsWith(`${NodePath.sep}icons.test.ts`))
      .filter((path) => barrel.test(NodeFS.readFileSync(path, "utf8")))
      .map((path) => NodePath.relative(SRC, path));

    expect({ count: offenders.length, offenders }).toEqual({ count: 0, offenders: [] });
  });

  it("names a real icon file for every export of the local icon list", () => {
    const list = NodeFS.readFileSync(NodePath.join(SRC, "ui", "icons.ts"), "utf8");
    const exports = [...list.matchAll(/export \{ default as (\w+) \} from "([^"]+)";/gu)];
    const packageDir = NodePath.join(SRC, "..", "node_modules", PACKAGE);

    expect(exports.length).toBeGreaterThan(0);
    for (const [, name, specifier] of exports) {
      expect(specifier).toBe(`${PACKAGE}/${name}`);
      expect(
        NodeFS.existsSync(NodePath.join(packageDir, "dist", "esm", "icons", `${name}.mjs`)),
      ).toBe(true);
    }
  });

  it("lists each icon once", () => {
    const list = NodeFS.readFileSync(NodePath.join(SRC, "ui", "icons.ts"), "utf8");
    const names = [...list.matchAll(/export \{ default as (\w+) \}/gu)].map((match) => match[1]);

    expect(new Set(names).size).toBe(names.length);
  });
});
