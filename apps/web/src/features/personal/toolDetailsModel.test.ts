import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "~/session-logic";

import { toolDetailsSummary } from "./toolDetailsModel";

function entry(
  overrides: Partial<WorkLogEntry> & Pick<WorkLogEntry, "id" | "label">,
): WorkLogEntry {
  return {
    createdAt: "2026-10-23T10:00:00.000Z",
    tone: "tool",
    ...overrides,
  } as WorkLogEntry;
}

describe("toolDetailsSummary", () => {
  it("names one family of work in one line", () => {
    const summary = toolDetailsSummary(
      [
        entry({ id: "1", label: "Ran npm test", command: "npm test" }),
        entry({ id: "2", label: "Ran tsc --noEmit", command: "tsc --noEmit" }),
        entry({ id: "3", label: "Ran git status", command: "git status" }),
      ],
      false,
      undefined,
    );
    expect(summary.label).toBe("Ran 3 commands");
    expect(summary.liveLabel).toBeNull();
    expect(summary.count).toBe(3);
  });

  it("counts failures on the summary and keeps the red count visible", () => {
    const summary = toolDetailsSummary(
      [
        entry({ id: "1", label: "Ran npm test", command: "npm test" }),
        entry({ id: "2", label: "Ran tsc", command: "tsc", tone: "error" }),
      ],
      false,
      undefined,
    );
    expect(summary.label).toBe("Ran 2 commands · 1 failed");
    expect(summary.failures).toBe(1);
  });

  it("uses the current action while live and the neutral count for mixed work", () => {
    const summary = toolDetailsSummary(
      [
        entry({ id: "1", label: "Read a.ts", requestKind: "file-read" }),
        entry({ id: "2", label: "Ran npm test", command: "npm test" }),
      ],
      true,
      undefined,
    );
    expect(summary.label).toBe("2 steps");
    expect(summary.liveLabel).toBe("npm test");
  });

  it("names reads and edits, and has nothing to say for an empty batch", () => {
    expect(
      toolDetailsSummary(
        [
          entry({ id: "1", label: "Read a.ts", requestKind: "file-read" }),
          entry({ id: "2", label: "Read b.ts", requestKind: "file-read" }),
        ],
        false,
        undefined,
      ).label,
    ).toBe("Read 2 files");
    expect(
      toolDetailsSummary(
        [
          entry({ id: "1", label: "Edited a.ts", changedFiles: ["a.ts"] }),
          entry({ id: "2", label: "Edited b.ts", changedFiles: ["b.ts"] }),
        ],
        false,
        undefined,
      ).label,
    ).toBe("Edited 2 files");
    expect(toolDetailsSummary([], true, undefined).label).toBe("Working…");
  });
});
