import { describe, expect, it } from "vite-plus/test";

import { linkTarget, markdownBlocks, markdownNeedsWidth } from "./markdown";

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

describe("markdownNeedsWidth", () => {
  it("asks for a definite width for lists and code blocks", () => {
    expect(markdownNeedsWidth("- one")).toBe(true);
    expect(markdownNeedsWidth("  - nested")).toBe(true);
    expect(markdownNeedsWidth("1. one")).toBe(true);
    expect(markdownNeedsWidth("```\nconst a = 1;\n```")).toBe(true);
  });

  it("asks for a definite width for a paragraph of file links", () => {
    expect(markdownNeedsWidth("[a](docs/a.md)\n[b](docs/b.json)")).toBe(true);
  });

  it("leaves a paragraph able to hug its text", () => {
    expect(markdownNeedsWidth("plain **bold** and `code` text")).toBe(false);
  });
});

describe("file links", () => {
  it("marks a paragraph made only of file links, using each basename", () => {
    const blocks = markdownBlocks(
      "[home-relative](.personal-bots/qa/run/RESULT.md)\n[ssh](~/.ssh/id_rsa)",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.files).toEqual([
      { path: ".personal-bots/qa/run/RESULT.md", label: "home-relative" },
      { path: "~/.ssh/id_rsa", label: "ssh" },
    ]);
  });

  it("marks a bullet list of file links", () => {
    const blocks = markdownBlocks(
      "- [home-relative](.personal-bots/qa/run/RESULT.md)\n- [png](docs/shot.png)",
    );
    expect(blocks.map((block) => block.files?.map((file) => file.path))).toEqual([
      [".personal-bots/qa/run/RESULT.md"],
      ["docs/shot.png"],
    ]);
  });

  it("keeps a file link inside prose as an ordinary span", () => {
    const blocks = markdownBlocks("Read [the plan](docs/plan.md) before you start.");
    expect(blocks[0]?.files).toBeUndefined();
  });
});

describe("linkTarget", () => {
  it("sends only http and https links outside the app", () => {
    expect(linkTarget("https://example.com/a")).toEqual({
      kind: "external",
      url: "https://example.com/a",
    });
    expect(linkTarget("http://example.com/a")).toEqual({
      kind: "external",
      url: "http://example.com/a",
    });
    expect(linkTarget("mailto:a@b.c")).toEqual({ kind: "blocked" });
    expect(linkTarget("tel:5551234")).toEqual({ kind: "blocked" });
    expect(linkTarget("sms:5551234")).toEqual({ kind: "blocked" });
    expect(linkTarget("javascript:alert(1)")).toEqual({ kind: "blocked" });
    expect(linkTarget("intent://scan/#Intent;scheme=zxing;end")).toEqual({ kind: "blocked" });
  });

  it("opens workspace and absolute file paths in the file sheet", () => {
    expect(linkTarget("docs/a.md")).toEqual({ kind: "file", path: "docs/a.md" });
    expect(linkTarget("C:/work/a.ts")).toEqual({ kind: "file", path: "C:/work/a.ts" });
    expect(linkTarget("~/notes/a.md")).toEqual({ kind: "file", path: "~/notes/a.md" });
    expect(linkTarget("~/.ssh/id_rsa")).toEqual({ kind: "file", path: "~/.ssh/id_rsa" });
  });
});
