import type * as Atom from "effect/unstable/reactivity";
import type { ProviderCatalogListResult } from "./catalogTypes";
import type { ProviderFacts } from "./providerFacts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";

import type { ProviderCatalogEntry } from "./catalogTypes";

type EnvironmentUnaryRpcTag = Parameters<typeof createEnvironmentRpcCommand>[1]["tag"];
const CATALOG_LIST_METHOD = ((WS_METHODS as Record<string, string>).providerCatalogList ??
  "provider.catalog.list") as EnvironmentUnaryRpcTag;
const CATALOG_ADD_METHOD = ((WS_METHODS as Record<string, string>).providerCatalogAdd ??
  "provider.catalog.add") as EnvironmentUnaryRpcTag;
const CATALOG_FACTS_METHOD = ((WS_METHODS as Record<string, string>).providerCatalogInstallFacts ??
  "provider.catalog.installFacts") as EnvironmentUnaryRpcTag;

/**
 * Catalogue list query atom family.
 * Hits provider.catalog.list on the connected environment.
 */
export const providerCatalogList: (target: {
  readonly environmentId: any;
  readonly input: { readonly refresh?: boolean };
}) => any = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "provider-catalog:list",
  tag: CATALOG_LIST_METHOD,
  staleTimeMs: 60_000,
  idleTtlMs: 5 * 60_000,
});

/**
 * Command to create a provider instance from a catalogue ID.
 * Returns { instanceId }.
 */
export const providerCatalogAdd = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "provider-catalog:add",
  tag: CATALOG_ADD_METHOD,
});

/**
 * Query for install facts (for the install confirmation sheet).
 */
export const providerCatalogInstallFacts: (target: {
  readonly environmentId: any;
  readonly input: { readonly catalogId: string };
}) => any = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "provider-catalog:install-facts",
  tag: CATALOG_FACTS_METHOD,
  staleTimeMs: 60_000,
  idleTtlMs: 5 * 60_000,
});

/**
 * Built-in fallback entries when server catalogue RPC is not available or registry fetch failed.
 * Matches SPEC Ãƒâ€šÃ‚Â§4 fallback behavior.
 */
export const BUILT_IN_CATALOG_FALLBACK: ReadonlyArray<ProviderCatalogEntry> = [
  {
    catalogId: "builtin:claudeAgent",
    source: "builtIn",
    name: "Claude Code",
    publisher: "Anthropic",
    description:
      "Anthropic's coding agent. Reads and edits code, runs commands and searches the web.",
    website: "https://anthropic.com",
    repository: null,
    license: "Proprietary",
    openSource: false,
    version: null,
    iconUrl: null,
    distribution: null,
    downloadBytes: null,
    sha256Checked: false,
    cost: {
      kind: "subscription",
      label: "Your Claude plan",
      detail: "It uses the Claude subscription you signed in with.",
    },
    signInLabel: "Claude account",
    popularRank: null,
    supported: { ok: true },
    added: { instanceId: "claudeAgent" },
  },
  {
    catalogId: "builtin:cursor",
    source: "builtIn",
    name: "Cursor",
    publisher: "Cursor",
    description: "Cursor's agent. Reads and edits code and runs commands.",
    website: "https://cursor.com",
    repository: null,
    license: "Proprietary",
    openSource: false,
    version: null,
    iconUrl: null,
    distribution: null,
    downloadBytes: null,
    sha256Checked: false,
    cost: {
      kind: "subscription",
      label: "Your Cursor plan",
      detail: "It uses the Cursor account you signed in with.",
    },
    signInLabel: "Cursor account",
    popularRank: 1,
    supported: { ok: true },
    added: { instanceId: "cursor" },
  },
  {
    catalogId: "gemini",
    source: "registry",
    name: "Gemini CLI",
    publisher: "Google",
    description:
      "Google's coding agent for Gemini models. Reads and edits code, runs commands and searches the web.",
    website: "https://gemini.google.com",
    repository: "https://github.com/google/gemini-cli",
    license: "Apache-2.0",
    openSource: true,
    version: "0.1.5",
    iconUrl: "/api/provider-catalog/icon/gemini",
    distribution: { kind: "npm", label: "npm Ãƒâ€šÃ‚Â· @google/gemini-cli" },
    downloadBytes: 99_000_000,
    sha256Checked: true,
    cost: {
      kind: "freeTier",
      label: "Free with a Google account",
      detail: "Daily limits apply. For more, sign in with a Google AI plan.",
    },
    signInLabel: "Google account or API key",
    popularRank: 2,
    supported: { ok: true },
    added: null,
  },
  {
    catalogId: "github-copilot-cli",
    source: "registry",
    name: "GitHub Copilot CLI",
    publisher: "GitHub",
    description:
      "GitHub's agent in your terminal. Asks questions, runs commands and explains errors.",
    website: "https://github.com/features/copilot",
    repository: null,
    license: "Proprietary",
    openSource: false,
    version: "0.1.20",
    iconUrl: "/api/provider-catalog/icon/github-copilot-cli",
    distribution: { kind: "binary", label: "GitHub release Ãƒâ€šÃ‚Â· github/copilot-cli" },
    downloadBytes: 42_000_000,
    sha256Checked: true,
    cost: {
      kind: "subscription",
      label: "Your Copilot plan",
      detail: "Included with GitHub Copilot subscriptions.",
    },
    signInLabel: "GitHub account",
    popularRank: 3,
    supported: { ok: true },
    added: null,
  },
  {
    catalogId: "qwen-code",
    source: "registry",
    name: "Qwen Code",
    publisher: "Alibaba",
    description: "Qwen's coding agent for open models. Runs locally or connects to DashScope.",
    website: "https://qwenlm.github.io",
    repository: "https://github.com/QwenLM/qwen-code",
    license: "Apache-2.0",
    openSource: true,
    version: "0.4.1",
    iconUrl: "/api/provider-catalog/icon/qwen-code",
    distribution: { kind: "npm", label: "npm Ãƒâ€šÃ‚Â· @qwen/code" },
    downloadBytes: 35_000_000,
    sha256Checked: true,
    cost: {
      kind: "freeTier",
      label: "Free with a Qwen account",
      detail: "Free tier with DashScope, or connect your own local endpoint.",
    },
    signInLabel: "Qwen account or API key",
    popularRank: 4,
    supported: { ok: true },
    added: null,
  },
  {
    catalogId: "kimi",
    source: "registry",
    name: "Kimi CLI",
    publisher: "Moonshot AI",
    description: "Moonshot's terminal coding agent with large context windows.",
    website: "https://moonshot.cn",
    repository: null,
    license: "Proprietary",
    openSource: false,
    version: "1.0.8",
    iconUrl: "/api/provider-catalog/icon/kimi",
    distribution: { kind: "binary", label: "Moonshot release Ãƒâ€šÃ‚Â· kimi-cli" },
    downloadBytes: 65_000_000,
    sha256Checked: true,
    cost: {
      kind: "subscription",
      label: "Your Kimi plan or API key",
      detail: "Uses your Moonshot AI subscription or pay as you go balance.",
    },
    signInLabel: "Moonshot account or API key",
    popularRank: 5,
    supported: { ok: true },
    added: null,
  },
  {
    catalogId: "mistral-vibe",
    source: "registry",
    name: "Mistral Vibe",
    publisher: "Mistral AI",
    description: "Mistral's fast coding assistant powered by Codestral.",
    website: "https://mistral.ai",
    repository: "https://github.com/mistralai/vibe",
    license: "Apache-2.0",
    openSource: true,
    version: "0.2.0",
    iconUrl: "/api/provider-catalog/icon/mistral-vibe",
    distribution: { kind: "npm", label: "npm Ãƒâ€šÃ‚Â· @mistralai/vibe" },
    downloadBytes: 28_000_000,
    sha256Checked: true,
    cost: {
      kind: "apiKey",
      label: "API key, pay as you go",
      detail: "Billed per message from your Mistral balance.",
    },
    signInLabel: "Mistral API key",
    popularRank: 6,
    supported: { ok: true },
    added: null,
  },
  {
    catalogId: "builtin:codex",
    source: "builtIn",
    name: "OpenAI Codex",
    publisher: "OpenAI",
    description: "OpenAI's coding agent. Reads and edits code, runs commands and searches the web.",
    website: "https://openai.com",
    repository: null,
    license: "Apache-2.0",
    openSource: true,
    version: null,
    iconUrl: null,
    distribution: null,
    downloadBytes: null,
    sha256Checked: false,
    cost: {
      kind: "subscription",
      label: "Your ChatGPT plan",
      detail: "It uses the ChatGPT subscription you signed in with.",
    },
    signInLabel: "ChatGPT account",
    popularRank: null,
    supported: { ok: true },
    added: { instanceId: "codex" },
  },
  {
    catalogId: "builtin:opencode",
    source: "builtIn",
    name: "OpenCode",
    publisher: "OpenCode",
    description: "An open source coding agent that works with many model providers.",
    website: "https://opencode.ai",
    repository: "https://github.com/opencode/opencode",
    license: "MIT",
    openSource: true,
    version: null,
    iconUrl: null,
    distribution: null,
    downloadBytes: null,
    sha256Checked: false,
    cost: {
      kind: "freeTier",
      label: "Free models or your own key",
      detail: "Free models are listed; others need an account with their provider.",
    },
    signInLabel: "Server address",
    popularRank: null,
    supported: { ok: true },
    added: { instanceId: "opencode" },
  },
  {
    catalogId: "builtin:deepseek",
    source: "builtIn",
    name: "DeepSeek",
    publisher: "DeepSeek",
    description: "DeepSeek's models, run through hbots' own coding harness.",
    website: "https://deepseek.com",
    repository: null,
    license: "Proprietary",
    openSource: false,
    version: null,
    iconUrl: null,
    distribution: null,
    downloadBytes: null,
    sha256Checked: false,
    cost: {
      kind: "payAsYouGo",
      label: "Pay as you go",
      detail: "Billed by DeepSeek per message from your balance.",
    },
    signInLabel: "API key",
    popularRank: null,
    supported: { ok: true },
    added: { instanceId: "deepseek" },
  },
  {
    catalogId: "builtin:antigravity",
    source: "builtIn",
    name: "Antigravity",
    publisher: "Google",
    description:
      "Google's coding agent for Gemini models. Reads and edits code, runs commands and searches the web.",
    website: "https://google.com",
    repository: null,
    license: "Proprietary",
    openSource: false,
    version: null,
    iconUrl: null,
    distribution: null,
    downloadBytes: null,
    sha256Checked: false,
    cost: {
      kind: "freeTier",
      label: "Free with a Google account",
      detail: "Daily limits apply. For more, sign in with a Google AI plan.",
    },
    signInLabel: "Google account",
    popularRank: null,
    supported: { ok: true },
    added: { instanceId: "antigravity" },
  },
  {
    catalogId: "unsupported-python-agent",
    source: "registry",
    name: "PyCode Assistant",
    publisher: "Community",
    description: "Python-based coding assistant that runs via uv tool.",
    website: null,
    repository: "https://github.com/example/pycode",
    license: "MIT",
    openSource: true,
    version: "0.9.0",
    iconUrl: null,
    distribution: { kind: "uvx", label: "uvx Ãƒâ€šÃ‚Â· pycode-cli" },
    downloadBytes: null,
    sha256Checked: false,
    cost: { kind: "free", label: "Free, open source", detail: null },
    signInLabel: null,
    popularRank: null,
    supported: { ok: false, reason: "needsUv" },
    added: null,
  },
];
