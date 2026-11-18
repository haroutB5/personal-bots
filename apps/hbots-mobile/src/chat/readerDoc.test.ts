import { describe, expect, it } from "vite-plus/test";

import { anchorOffset, readerDoc } from "./readerDoc";

describe("readerDoc", () => {
  it("B1 strips markers and joins blocks with a blank line", () => {
    const doc = readerDoc("## Plan\n\nRun **fast** now.\n\n```bash\nls\n```");
    expect(doc.text).toBe("Plan\n\nRun fast now.\n\nls");
    expect(doc.text).not.toMatch(/##|\*\*|```/u);
    expect(doc.runs.map((run) => run.text).join("")).toBe(doc.text);
  });

  it("B2 styles each run, and bullets and tables read as plain text", () => {
    const doc = readerDoc("- one **two**\n\n| a | b |\n|---|---|\n| c | d |");
    expect(doc.text).toBe("• one two\n\na\tb\nc\td");
    expect(doc.runs.find((run) => run.text === "two")?.style).toBe("bold");
  });

  it("B3 anchorOffset finds the tapped word in the document", () => {
    const doc = readerDoc("## Plan\n\nRun **fast** now.");
    expect(anchorOffset(doc, { text: "Run fast now.", offset: 4 })).toBe(doc.text.indexOf("fast"));
  });

  it("B4 an unknown hit returns null", () => {
    const doc = readerDoc("Run **fast** now.");
    expect(anchorOffset(doc, { text: "Something else entirely", offset: 3 })).toBeNull();
    expect(anchorOffset(doc, { text: "Run fast now.", offset: 99 })).toBeNull();
  });
});
