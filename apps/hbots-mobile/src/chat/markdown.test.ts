import { describe, expect, it } from "vite-plus/test";

import { linkTarget, markdownBlocks, markdownNeedsWidth } from "./markdown";

describe("markdownBlocks", () => {
  it("keeps paragraphs, headings and lists", () => {
    const blocks = markdownBlocks("# Title\n\nHello **world**\n\n- one\n- two");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "bullet", "bullet"]);
    expect(blocks[1]).toMatchObject({
      kind: "paragraph",
      spans: [
        { kind: "text", text: "Hello " },
        { kind: "bold", text: "world" },
      ],
    });
  });

  it("keeps fenced code as one block", () => {
    const blocks = markdownBlocks("before\n\n```ts\nconst a = 1;\n```");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "code"]);
    expect(blocks[1]).toMatchObject({ kind: "code", text: "const a = 1;", language: "ts" });
  });

  it("keeps a paragraph together across line breaks", () => {
    const blocks = markdownBlocks("first line\nsecond line");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "first line\nsecond line" });
  });

  it("turns external markdown links into link spans, keeping the label and target", () => {
    const blocks = markdownBlocks(
      "Read [the plan](https://example.com/plan) and [the docs](http://example.com).",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "paragraph",
      spans: [
        { kind: "text", text: "Read " },
        { kind: "link", text: "the plan", href: "https://example.com/plan" },
        { kind: "text", text: " and " },
        { kind: "link", text: "the docs", href: "http://example.com" },
        { kind: "text", text: "." },
      ],
    });
  });

  it("nests indented bullets by their indent", () => {
    const blocks = markdownBlocks("- one\n  - nested\n    - deep\n- two");
    expect(
      blocks.map((block) => (block.kind === "bullet" ? [block.kind, block.text, block.depth] : [])),
    ).toEqual([
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

describe("markdown features the chat renders", () => {
  it("keeps headings at every level", () => {
    const blocks = markdownBlocks("# one\n## two\n### three\n#### four\n##### five\n###### six");
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "heading",
      "heading",
      "heading",
      "heading",
      "heading",
    ]);
    expect(blocks.map((block) => (block.kind === "heading" ? block.text : ""))).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
    ]);
  });

  it("keeps a numbered list", () => {
    const blocks = markdownBlocks("1. one\n2. two");
    expect(
      blocks.map((block) =>
        block.kind === "number" ? [block.kind, block.marker, block.text, block.depth] : [],
      ),
    ).toEqual([
      ["number", "1", "one", 0],
      ["number", "2", "two", 0],
    ]);
  });

  it("nests an indented numbered item", () => {
    const blocks = markdownBlocks("1. one\n   1. nested");
    expect(
      blocks.map((block) => (block.kind === "number" ? [block.text, block.depth] : [])),
    ).toEqual([
      ["one", 0],
      ["nested", 1],
    ]);
  });

  it("keeps a blockquote with inline formatting", () => {
    const blocks = markdownBlocks("> **quoted** text");
    expect(blocks[0]).toMatchObject({
      kind: "quote",
      spans: [
        { kind: "bold", text: "quoted" },
        { kind: "text", text: " text" },
      ],
    });
  });
});

describe("markdown tables", () => {
  it("parses a GFM table with a header, alignment and body rows", () => {
    const blocks = markdownBlocks(
      "| Piece | Status |\n| :--- | ---: |\n| api | green |\n| ui | red |",
    );
    expect(blocks).toEqual([
      {
        kind: "table",
        table: {
          header: [
            { text: "Piece", spans: [{ kind: "text", text: "Piece" }] },
            { text: "Status", spans: [{ kind: "text", text: "Status" }] },
          ],
          aligns: ["left", "right"],
          rows: [
            [
              { text: "api", spans: [{ kind: "text", text: "api" }] },
              { text: "green", spans: [{ kind: "text", text: "green" }] },
            ],
            [
              { text: "ui", spans: [{ kind: "text", text: "ui" }] },
              { text: "red", spans: [{ kind: "text", text: "red" }] },
            ],
          ],
        },
      },
    ]);
  });

  it("parses a table without outer pipes and a centered column", () => {
    const blocks = markdownBlocks("name | value\n:---: | ---\na | 1");
    expect(blocks[0]).toMatchObject({
      kind: "table",
      table: {
        aligns: ["center", "left"],
        header: [{ text: "name" }, { text: "value" }],
        rows: [[{ text: "a" }, { text: "1" }]],
      },
    });
  });

  it("keeps bold text inside a table cell", () => {
    const blocks = markdownBlocks("| A |\n| --- |\n| **bold** |");
    expect(blocks[0]).toMatchObject({
      kind: "table",
      table: { rows: [[{ text: "**bold**", spans: [{ kind: "bold", text: "bold" }] }]] },
    });
  });

  it("keeps inline code inside a table cell", () => {
    const blocks = markdownBlocks("| Run |\n| --- |\n| `vp test` |");
    expect(blocks[0]).toMatchObject({
      kind: "table",
      table: { rows: [[{ text: "`vp test`", spans: [{ kind: "code", text: "vp test" }] }]] },
    });
  });

  it("keeps links inside a table cell", () => {
    const blocks = markdownBlocks("| Docs |\n| --- |\n| [plan](https://example.com/plan) |");
    expect(blocks[0]).toMatchObject({
      kind: "table",
      table: {
        rows: [
          [
            {
              text: "[plan](https://example.com/plan)",
              spans: [{ kind: "link", text: "plan", href: "https://example.com/plan" }],
            },
          ],
        ],
      },
    });
  });

  it("unescapes a pipe inside a cell", () => {
    const blocks = markdownBlocks("| Value |\n| --- |\n| a \\| b |");
    expect(blocks[0]).toMatchObject({
      kind: "table",
      table: { rows: [[{ text: "a | b", spans: [{ kind: "text", text: "a | b" }] }]] },
    });
  });

  it("pads a body row with fewer cells", () => {
    const blocks = markdownBlocks("| A | B |\n| --- | --- |\n| 1 |");
    expect(blocks[0]).toMatchObject({
      kind: "table",
      table: { rows: [[{ text: "1" }, { text: "" }]] },
    });
  });

  it("ends the table at a line without a pipe", () => {
    const blocks = markdownBlocks("| A |\n| --- |\n| 1 |\nafter");
    expect(blocks.map((block) => block.kind)).toEqual(["table", "paragraph"]);
    expect(blocks[1]).toMatchObject({ kind: "paragraph", text: "after" });
  });

  it("falls back to plain text when the delimiter row is malformed", () => {
    const blocks = markdownBlocks("| A | B |\n| --- |\n| 1 | 2 |");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "paragraph",
      text: "| A | B |\n| --- |\n| 1 | 2 |",
    });
  });
});

describe("markdownNeedsWidth", () => {
  it("asks for a definite width for lists and code blocks", () => {
    expect(markdownNeedsWidth("- one")).toBe(true);
    expect(markdownNeedsWidth("  - nested")).toBe(true);
    expect(markdownNeedsWidth("1. one")).toBe(true);
    expect(markdownNeedsWidth("```\nconst a = 1;\n```")).toBe(true);
  });

  it("asks for a definite width for a table", () => {
    expect(markdownNeedsWidth("| A | B |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
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
    expect(blocks[0]).toMatchObject({
      kind: "paragraph",
      files: [
        {
          path: ".personal-bots/qa/run/RESULT.md",
          label: "home-relative",
          name: "RESULT.md",
        },
        { path: "~/.ssh/id_rsa", label: "ssh", name: "id_rsa" },
      ],
    });
  });

  it("marks a bullet list of file links", () => {
    const blocks = markdownBlocks(
      "- [home-relative](.personal-bots/qa/run/RESULT.md)\n- [png](docs/shot.png)",
    );
    expect(
      blocks.map((block) => ("files" in block ? block.files?.map((file) => file.path) : [])),
    ).toEqual([[".personal-bots/qa/run/RESULT.md"], ["docs/shot.png"]]);
  });

  it("turns an absolute path in inline code into a file span with its basename", () => {
    const blocks = markdownBlocks("`/home/harout/.personal-bots/run/restart-1.67.0-result.json`");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "paragraph",
      spans: [
        {
          kind: "file",
          path: "/home/harout/.personal-bots/run/restart-1.67.0-result.json",
          label: "/home/harout/.personal-bots/run/restart-1.67.0-result.json",
          name: "restart-1.67.0-result.json",
        },
      ],
    });
  });

  it("puts a chip inside a sentence and inside a bullet", () => {
    const blocks = markdownBlocks(
      "Evidence: `/home/harout/run/result.json` is ready.\n\n- See [the report](/home/harout/qa/REPORT.md) now.",
    );
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "bullet"]);
    expect(blocks[0]).toMatchObject({
      kind: "paragraph",
      spans: [
        { kind: "text", text: "Evidence: " },
        {
          kind: "file",
          path: "/home/harout/run/result.json",
          label: "/home/harout/run/result.json",
          name: "result.json",
        },
        { kind: "text", text: " is ready." },
      ],
    });
    expect(blocks[1]).toMatchObject({
      kind: "bullet",
      spans: [
        { kind: "text", text: "See " },
        {
          kind: "file",
          path: "/home/harout/qa/REPORT.md",
          label: "the report",
          name: "REPORT.md",
        },
        { kind: "text", text: " now." },
      ],
    });
  });

  it("leaves text that is not a path in inline code", () => {
    const blocks = markdownBlocks("Run `vp test` and `/`.");
    expect(blocks[0]).toMatchObject({
      kind: "paragraph",
      spans: [
        { kind: "text", text: "Run " },
        { kind: "code", text: "vp test" },
        { kind: "text", text: " and " },
        { kind: "code", text: "/" },
        { kind: "text", text: "." },
      ],
    });
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
