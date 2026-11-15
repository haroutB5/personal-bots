import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { sheetBodyMaxHeight } from "./projectSheetLayout";

const source = NodeFS.readFileSync(new URL("./ProjectSheet.tsx", import.meta.url), "utf8");

/** Everything the goal sheet shows, from the ScrollView open tag to its close. */
function scrollBody(): string {
  const open = source.indexOf("<ScrollView");
  const close = source.lastIndexOf("</ScrollView>");
  return open < 0 || close <= open ? "" : source.slice(open, close);
}

describe("the goal sheet body", () => {
  it("scrolls the whole sheet, so the last action is reachable", () => {
    const body = scrollBody();
    expect(body).toContain('testID="project-sheet"');
    expect(body).toContain('Open ${lead?.name ?? "lead"} chat');
  });

  it("sizes the scroll to fit inside the shell and clears the safe-area inset", () => {
    expect(scrollBody()).toContain("sheetBodyMaxHeight(height, insets.bottom)");
    expect(source).toContain("useSafeAreaInsets()");
  });

  it("keys the folds to the open goal, so a new goal opens folded", () => {
    expect(source).toMatch(/foldForProject\(\s*lastFold,\s*card\?\.projectId \?\? null,?\s*\)/);
    expect(source).toMatch(/if \(fold !== lastFold\)\s*setFold\(fold\)/);
  });
});

describe("the goal sheet's scroll height", () => {
  it("fits the shell's 90% cap with its chrome and bottom padding", () => {
    for (const [height, inset] of [
      [640, 0],
      [785, 0],
      [785, 24],
      [915, 48],
    ] as ReadonlyArray<readonly [number, number]>) {
      const used = 110 + sheetBodyMaxHeight(height, inset) + Math.max(inset, 12);
      expect(used).toBeLessThanOrEqual(Math.round(height * 0.9));
    }
  });

  it("keeps a usable scroll area on the shortest phone", () => {
    expect(sheetBodyMaxHeight(785, 24)).toBe(573);
    expect(sheetBodyMaxHeight(360, 48)).toBeGreaterThan(150);
  });
});
