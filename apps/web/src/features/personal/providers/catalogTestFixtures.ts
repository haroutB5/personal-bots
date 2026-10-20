import type { ProviderCatalogEntry } from "./catalogTypes";

/**
 * Test fixtures from Backend's fixture apps/server/src/provider/catalog/fixtures/registry-2026-10-20.json.
 * Used for visual verification and testing until Backend's RPC is merged into this branch.
 */
export const TEST_CATALOG_FIXTURES: Record<string, ProviderCatalogEntry> = {
  "fast-agent": {
    catalogId: "fast-agent",
    source: "registry",
    name: "fast-agent",
    publisher: "evalstate",
    description: "Code and build agents with comprehensive multi-provider support",
    website: "https://fast-agent.ai",
    repository: "https://github.com/evalstate/fast-agent",
    license: "Apache 2.0",
    openSource: true,
    version: "0.10.1",
    iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/fast-agent.svg",
    distribution: { kind: "uvx", label: "uvx · fast-agent-acp@0.10.1" },
    downloadBytes: null,
    sha256Checked: false,
    cost: { kind: "free", label: "Free, open source", detail: null },
    signInLabel: null,
    popularRank: null,
    supported: { ok: false, reason: "needsUv" },
    added: null,
  },
  gemini: {
    catalogId: "gemini",
    source: "registry",
    name: "Gemini CLI",
    publisher: "Google",
    description: "Google's official CLI for Gemini",
    website: "https://geminicli.com",
    repository: "https://github.com/google-gemini/gemini-cli",
    license: "Apache-2.0",
    openSource: true,
    version: "0.64.0",
    iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/gemini.svg",
    distribution: { kind: "npm", label: "npm · @google/gemini-cli" },
    downloadBytes: null,
    sha256Checked: false,
    cost: {
      kind: "freeTier",
      label: "Free with a Google account",
      detail: "Daily limits apply. For more, sign in with a Google AI plan.",
    },
    signInLabel: "Google account or API key",
    popularRank: 1,
    supported: { ok: true },
    added: null,
  },
};
