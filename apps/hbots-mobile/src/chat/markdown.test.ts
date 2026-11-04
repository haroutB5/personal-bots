import { describe, expect, it } from "vite-plus/test";

import { markdownBlocks } from "./markdown";

describe("markdownBlocks", () => {
  it("keeps paragraphs, headings and lists", () => {
    const blocks = markdownBlocks("# Title\n\nHello **world**\n\n- one\n- two");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "bullet", "bullet"]);
    expect(blocks[1]?.spans).toEqual([
      { kind: "text", text: "Hello " },
      { kind: "bold", text: "world" },
    ]);
  });

  it("keeps fenced code as one block", () => {
    const blocks = markdownBlocks("before\n\n```ts\nconst a = 1;\n```");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "code"]);
    expect(blocks[1]?.text).toBe("const a = 1;");
    expect(blocks[1]?.language).toBe("ts");
  });

  it("keeps a paragraph together across line breaks", () => {
    const blocks = markdownBlocks("first line\nsecond line");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("first line\nsecond line");
  });

  it("turns markdown links into link spans, keeping the label and target", () => {
    const blocks = markdownBlocks(
      "Read [the plan](docs/plan.md) and [the site](https://example.com).",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.spans).toEqual([
      { kind: "text", text: "Read " },
      { kind: "link", text: "the plan", href: "docs/plan.md" },
      { kind: "text", text: " and " },
      { kind: "link", text: "the site", href: "https://example.com" },
      { kind: "text", text: "." },
    ]);
  });

  it("nests indented bullets by their indent", () => {
    const blocks = markdownBlocks("- one\n  - nested\n    - deep\n- two");
    expect(blocks.map((block) => [block.kind, block.text, block.depth])).toEqual([
      ["bullet", "one", 0],
      ["bullet", "nested", 1],
      ["bullet", "deep", 2],
      ["bullet", "two", 0],
    ]);
  });

  it("keeps a fenced code block literal, including link-like text", () => {
    const blocks = markdownBlocks("```\n[a](b)\n- not a bullet\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code", text: "[a](b)\n- not a bullet" });
  });
});
