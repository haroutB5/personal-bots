import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const SOURCE = NodeFS.readFileSync(
  NodePath.join(NodeURL.fileURLToPath(new URL(".", import.meta.url)), "ComputerLiveView.tsx"),
  "utf8",
);

function openingTag(text: string, tag: string): string {
  const start = text.indexOf(`<${tag}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("/>", start);
  return text.slice(start, end + 2);
}

describe("ComputerLiveView keyboard wiring", () => {
  it("gives the hidden text field a ref so the app can focus it", () => {
    expect(openingTag(SOURCE, "TextInput")).toContain("ref={fieldRef}");
  });

  it("lets only the field's own focus events write the keyboard state", () => {
    const writes = SOURCE.match(/setKeyboardOpen\(/g) ?? [];
    expect(SOURCE).toContain("onFocus={() => setKeyboardOpen(true)}");
    expect(SOURCE).toContain("onBlur={() => {");
    expect(SOURCE).not.toContain("setKeyboardOpen((open)");
    expect(writes.length).toBeLessThanOrEqual(3);
  });

  it("routes the dock button and the server's focus report through liveKeyboardStep", () => {
    expect(SOURCE).toContain('kind: "toggle"');
    expect(SOURCE).toContain('kind: "focusReport"');
  });
});
