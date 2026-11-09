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

  it("turns external markdown links into link spans, keeping the label and target", () => {
    const blocks = markdownBlocks(
      "Read [the plan](https://example.com/plan) and [the docs](http://example.com).",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.spans).toEqual([
      { kind: "text", text: "Read " },
      { kind: "link", text: "the plan", href: "https://example.com/plan" },
      { kind: "text", text: " and " },
      { kind: "link", text: "the docs", href: "http://example.com" },
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

  it("asks for a definite width for an inline file chip", () => {
    expect(markdownNeedsWidth("See `/home/harout/run/result.json` now.")).toBe(true);
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
      {
        path: ".personal-bots/qa/run/RESULT.md",
        label: "home-relative",
        name: "RESULT.md",
      },
      { path: "~/.ssh/id_rsa", label: "ssh", name: "id_rsa" },
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

  it("turns an absolute path in inline code into a file span with its basename", () => {
    const blocks = markdownBlocks("`/home/harout/.personal-bots/run/restart-1.67.0-result.json`");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.spans).toEqual([
      {
        kind: "file",
        path: "/home/harout/.personal-bots/run/restart-1.67.0-result.json",
        label: "/home/harout/.personal-bots/run/restart-1.67.0-result.json",
        name: "restart-1.67.0-result.json",
      },
    ]);
  });

  it("puts a chip inside a sentence and inside a bullet", () => {
    const blocks = markdownBlocks(
      "Evidence: `/home/harout/run/result.json` is ready.\n\n- See [the report](/home/harout/qa/REPORT.md) now.",
    );
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "bullet"]);
    expect(blocks[0]?.spans).toEqual([
      { kind: "text", text: "Evidence: " },
      {
        kind: "file",
        path: "/home/harout/run/result.json",
        label: "/home/harout/run/result.json",
        name: "result.json",
      },
      { kind: "text", text: " is ready." },
    ]);
    expect(blocks[1]?.spans).toEqual([
      { kind: "text", text: "See " },
      {
        kind: "file",
        path: "/home/harout/qa/REPORT.md",
        label: "the report",
        name: "REPORT.md",
      },
      { kind: "text", text: " now." },
    ]);
  });

  it("leaves text that is not a path in inline code", () => {
    const blocks = markdownBlocks("Run `vp test` and `/`.");
    expect(blocks[0]?.spans).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "vp test" },
      { kind: "text", text: " and " },
      { kind: "code", text: "/" },
      { kind: "text", text: "." },
    ]);
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
