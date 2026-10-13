import { describe, expect, it } from "vite-plus/test";

import { stepSummaryLabel } from "./ToolDetails";

describe("stepSummaryLabel", () => {
  it("keeps the step's own words", () => {
    expect(stepSummaryLabel("Read")).toBe("Read");
    expect(stepSummaryLabel("User input requested")).toBe("User input requested");
    expect(stepSummaryLabel("Ran pnpm test")).toBe("Ran pnpm test");
  });

  it("cuts the raw tool argument off, and the hanging punctuation with it", () => {
    expect(stepSummaryLabel('Read: {"file_path":"C:/repo/apps/web/src/x.ts"}')).toBe("Read");
    expect(stepSummaryLabel('Bash: ["rg", "list"]')).toBe("Bash");
    expect(stepSummaryLabel("Edited ")).toBe("Edited");
  });

  it("gives nothing for a label that is only the argument", () => {
    expect(stepSummaryLabel('{"file_path":"C:/repo/x.ts"}')).toBeNull();
    expect(stepSummaryLabel("}")).toBeNull();
    expect(stepSummaryLabel("")).toBeNull();
  });

  it("caps a long phrase", () => {
    const long = "Read a very long list of files from the repository and their contents";
    const capped = stepSummaryLabel(long);
    expect(capped?.length).toBeLessThanOrEqual(48);
    expect(capped?.endsWith("…")).toBe(true);
  });
});
