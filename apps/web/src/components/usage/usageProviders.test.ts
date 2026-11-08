import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_PRESENTATION, rankProvidersByMetric } from "./usageProviders";

describe("PROVIDER_PRESENTATION", () => {
  it("shows DeepSeek with a label and its own driver", () => {
    expect(PROVIDER_PRESENTATION.deepseek).toEqual({
      label: "DeepSeek",
      color: "#4d6bfe",
      driverKind: ProviderDriverKind.make("deepseek"),
    });
  });
});

describe("rankProvidersByMetric", () => {
  it("ranks by the selected metric, highest first", () => {
    const totals = [
      { provider: "codex" as const, totalTokens: 100, costUsd: 20 },
      { provider: "claude" as const, totalTokens: 200, costUsd: 10 },
    ];
    const providers = ["codex", "claude"] as const;

    expect(rankProvidersByMetric(providers, totals, "tokens")).toEqual(["claude", "codex"]);
    expect(rankProvidersByMetric(providers, totals, "cost")).toEqual(["codex", "claude"]);
  });

  it("keeps ties in input order without reordering the shared provider list", () => {
    const totals = [
      { provider: "codex" as const, totalTokens: 10, costUsd: 1 },
      { provider: "claude" as const, totalTokens: 10, costUsd: 1 },
      { provider: "grok" as const, totalTokens: 20, costUsd: 2 },
    ];
    const providers = ["claude", "codex", "grok"] as const;

    expect(rankProvidersByMetric(providers, totals, "tokens")).toEqual(["grok", "claude", "codex"]);
    expect(providers).toEqual(["claude", "codex", "grok"]);
  });
});
