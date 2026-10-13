// @effect-diagnostics nodeBuiltinImport:off - reads the shipped stylesheet off disk.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * The home must never hand a sideways drag to the browser. QA's 1.66.36 report:
 * a horizontal swipe on the pinned strip acted as browser Back in 5 of 5 runs.
 * The home's own sideways scroller (the rail) has to keep its touch, and a row
 * and the page have nothing to do with it. These rules are CSS, so the test
 * reads the stylesheet and pins the contract the components' class names carry.
 */
const CSS = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("./personal.css", import.meta.url)),
  "utf8",
);

function blockOf(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, `selector ${selector} missing from personal.css`).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf("}", start));
}

describe("the home's touch behaviour", () => {
  it("keeps a sideways drag on the rail: contained and pan-x", () => {
    const rail = blockOf(".home-rail");
    expect(rail).toContain("overscroll-behavior-x: contain");
    expect(rail).toContain("touch-action: pan-x");
  });

  it("keeps a row's touch vertical", () => {
    expect(blockOf(".home-row")).toContain("touch-action: pan-y");
  });

  it("refuses the page's own horizontal overscroll under the shell", () => {
    const start = CSS.indexOf("html:has(.personal-app)");
    expect(start, "the root overscroll rule is missing from personal.css").toBeGreaterThan(-1);
    expect(CSS.slice(start, CSS.indexOf("}", start))).toContain("overscroll-behavior-x: none");
  });
});
