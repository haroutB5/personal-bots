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
});
