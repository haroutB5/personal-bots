import { describe, expect, it } from "vite-plus/test";

import {
  performanceGroupDetail,
  performanceProviderLabel,
  processCountLabel,
} from "./performanceGroupLabel";

describe("performanceProviderLabel", () => {
  it("names each provider the bots UI knows, Claude Code first", () => {
    // QA's live check on 1.66.41 labelled every bot "Claude Code"; the real
    // provider now comes from the feed.
    expect(performanceProviderLabel("claudeAgent")).toBe("Claude Code");
    expect(performanceProviderLabel("codex")).toBe("Codex");
    expect(performanceProviderLabel("deepseek")).toBe("DeepSeek");
    expect(performanceProviderLabel("opencode")).toBe("OpenCode");
  });

  it("shows no provider for one it has no name for, never a guess", () => {
    expect(performanceProviderLabel("mystery-cli")).toBeNull();
    expect(performanceProviderLabel(null)).toBeNull();
    expect(performanceProviderLabel(undefined)).toBeNull();
    expect(performanceProviderLabel("")).toBeNull();
  });
});

describe("processCountLabel", () => {
  it("says 1 process, not 1 processes", () => {
    expect(processCountLabel(1)).toBe("1 process");
    expect(processCountLabel(0)).toBe("0 processes");
    expect(processCountLabel(5)).toBe("5 processes");
  });
});

describe("performanceGroupDetail", () => {
  it("puts a bot's own provider before its count", () => {
    expect(performanceGroupDetail({ kind: "bot", provider: "codex", processCount: 2 })).toBe(
      "Codex · 2 processes",
    );
    expect(performanceGroupDetail({ kind: "bot", provider: "deepseek", processCount: 1 })).toBe(
      "DeepSeek · 1 process",
    );
  });

  it("leaves the count alone for an unknown provider or a non-bot group", () => {
    expect(performanceGroupDetail({ kind: "bot", provider: "mystery-cli", processCount: 1 })).toBe(
      "1 process",
    );
    expect(performanceGroupDetail({ kind: "app", provider: null, processCount: 1 })).toBe(
      "1 process",
    );
    expect(performanceGroupDetail({ kind: "hbots", provider: null, processCount: 12 })).toBe(
      "12 processes",
    );
  });
});
