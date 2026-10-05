import { describe, expect, it } from "vite-plus/test";

import { HIDDEN_SUMMARY_LABEL, maskHiddenTaskSummary } from "./previewPrivacy";

const entry = (patch: Record<string, unknown> = {}) => ({
  kind: "task_summary",
  scope: "bot",
  scopeId: "cfo",
  content: 'Task "Portfolio": Portfolio £27,636 at 21:06',
  ...patch,
});

describe("memory task summaries of a hidden bot", () => {
  const bots = new Map<string, { hidePreviews?: boolean }>([
    ["cfo", { hidePreviews: true }],
    ["assistant", {}],
  ]);

  it("show a neutral line instead of the clipped result", () => {
    expect(maskHiddenTaskSummary(entry(), bots).content).toBe(HIDDEN_SUMMARY_LABEL);
  });

  it("leave other bots, notes, rules and shared entries as saved", () => {
    expect(maskHiddenTaskSummary(entry({ scopeId: "assistant" }), bots).content).toContain(
      "Portfolio",
    );
    expect(maskHiddenTaskSummary(entry({ kind: "note" }), bots).content).toContain("Portfolio");
    expect(maskHiddenTaskSummary(entry({ kind: "preference" }), bots).content).toContain(
      "Portfolio",
    );
    expect(
      maskHiddenTaskSummary(entry({ scope: "shared", scopeId: null }), bots).content,
    ).toContain("Portfolio");
    expect(maskHiddenTaskSummary(entry({ scopeId: "gone-bot" }), bots).content).toContain(
      "Portfolio",
    );
  });
});
