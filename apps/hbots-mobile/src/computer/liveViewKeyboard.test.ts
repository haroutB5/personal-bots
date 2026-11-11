import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SOURCE = NodeFS.readFileSync(
  NodePath.join(NodeURL.fileURLToPath(new URL(".", import.meta.url)), "ComputerLiveView.tsx"),
  "utf8",
);

function openingTag(text: string, tag: string): string {
  const start = text.search(new RegExp(`<${tag}\\s`));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("/>", start);
  return text.slice(start, end + 2);
}

describe("ComputerLiveView keyboard wiring", () => {
  it("gives the hidden text field a ref so the app can focus it", () => {
    expect(openingTag(SOURCE, "TextInput")).toContain("ref={fieldRef}");
  });

  it("lets only the field's own focus events open the keyboard state", () => {
    expect(SOURCE.match(/setKeyboardOpen\(true\)/g)).toHaveLength(1);
    expect(SOURCE).not.toContain("setKeyboardOpen((");
    expect(SOURCE).toMatch(
      /onFocus=\{\(\) => \{\s*keyboardOpenRef\.current = true;\s*setKeyboardOpen\(true\);/,
    );
    expect(SOURCE).toContain("active={keyboardOpen}");
  });

  it("routes the dock button and the server's focus report through liveKeyboardStep", () => {
    expect(SOURCE).toContain('kind: "toggle"');
    expect(SOURCE).toContain('kind: "focusReport"');
  });
});
