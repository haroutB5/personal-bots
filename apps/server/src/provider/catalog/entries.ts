/**
 * Builds the catalogue (SPEC 11.1): the built-in providers plus every registry
 * agent, minus registry copies of the built-ins and minus what the overlay
 * hides. Pure: the registry, overlay, size probes and added instances come in,
 * entries come out.
 *
 * @module provider/catalog/entries
 */
import {
  ProviderInstanceId,
  type ProviderCatalogCost,
  type ProviderCatalogDistribution,
  type ProviderCatalogEntry,
} from "@t3tools/contracts";

import type { CatalogOverlay, CatalogOverlayEntry } from "./overlay.ts";
import { resolveInstallPlan, type InstallPlan } from "./plan.ts";
import {
  githubRepoOf,
  type ParsedRegistry,
  type RegistryAgent,
  type RegistryPlatform,
} from "./registry.ts";

export interface BuiltInDescriptor {
  /** Driver kind: `claudeAgent`, `codex`, ... The catalogue id is `builtin:<driver>`. */
  readonly driver: string;
  readonly name: string;
  readonly publisher: string;
  readonly description: string;
  readonly website: string | null;
  readonly repository: string | null;
  readonly license: string;
  /** The registry's copy of this provider, which the registry side drops. */
  readonly registryId: string | null;
  readonly version?: string | null;
  readonly distribution?: ProviderCatalogDistribution | null;
  readonly downloadBytes?: number | null;
  readonly sha256Checked?: boolean;
}

export const BUILT_IN_DESCRIPTORS: ReadonlyArray<BuiltInDescriptor> = [
  {
    driver: "claudeAgent",
    name: "Claude Code",
    publisher: "Anthropic",
    description: "Anthropic's coding agent, run through your Claude plan.",
    website: "https://claude.com/product/claude-code",
    repository: null,
    license: "proprietary",
    registryId: "claude-acp",
  },
  {
    driver: "codex",
    name: "Codex",
    publisher: "OpenAI",
    description: "OpenAI's coding agent, run through your ChatGPT plan.",
    website: "https://openai.com/codex",
    repository: "https://github.com/openai/codex",
    license: "Apache-2.0",
    registryId: "codex-acp",
  },
  {
    driver: "opencode",
    name: "OpenCode",
    publisher: "Anomaly",
    description: "An open source coding agent that works with many models.",
    website: "https://opencode.ai",
    repository: "https://github.com/sst/opencode",
    license: "MIT",
    registryId: "opencode",
  },
  {
    driver: "cursor",
    name: "Cursor",
    publisher: "Cursor",
    description: "Cursor's coding agent, run through your Cursor plan.",
    website: "https://cursor.com/docs/cli/acp",
    repository: null,
    license: "proprietary",
    registryId: "cursor",
  },
  {
    driver: "grok",
    name: "Grok",
    publisher: "xAI",
    description: "xAI's coding agent.",
    website: "https://x.ai/cli",
    repository: null,
    license: "proprietary",
    registryId: "grok-build",
  },
  {
    driver: "antigravity",
    name: "Antigravity",
    publisher: "Google LLC",
    description: "Google's coding agent.",
    website: "https://antigravity.google",
    repository: null,
    license: "proprietary",
    registryId: "antigravity-acp",
  },
  {
    driver: "deepseek",
    name: "DeepSeek",
    publisher: "DeepSeek",
    description: "DeepSeek models, run through the DeepSeek Harness or Claude Code.",
    website: "https://www.deepseek.com",
    repository: null,
    license: "unknown",
    registryId: null,
  },
];

export const builtInCatalogId = (driver: string): string => `builtin:${driver}`;

export interface BuildCatalogInput {
  /** Null when no registry copy exists yet: the built-ins still list. */
  readonly registry: ParsedRegistry | null;
  readonly overlay: CatalogOverlay;
  readonly platform: RegistryPlatform | null;
  /** False when there is no Node.js on this machine. Default true. */
  readonly nodeAvailable?: boolean;
  /** Archive URL to size in bytes, from HEAD requests. A missing URL means unknown. */
  readonly sizes?: ReadonlyMap<string, number>;
  /** Catalogue id to the instance already created from it. */
  readonly added?: ReadonlyMap<string, string>;
  readonly builtIns?: ReadonlyArray<BuiltInDescriptor>;
  /** Server route that proxies the icon for one catalogue id. */
  readonly iconUrlFor?: (catalogId: string) => string;
}

export const defaultIconUrlFor = (catalogId: string): string =>
  `/api/provider-catalog/icon/${encodeURIComponent(catalogId)}`;

const UNKNOWN_COST: ProviderCatalogCost = {
  kind: "unknown",
  label: "Price not listed",
  detail: null,
};

/** Licence is open source unless it says proprietary (or is missing). */
export function isOpenSourceLicense(license: string | null): boolean {
  if (license === null) return false;
  const text = license.trim().toLowerCase();
  return (
    text !== "" && text !== "unknown" && !/proprietary|commercial|closed|unlicensed/u.test(text)
  );
}

function publisherOf(agent: RegistryAgent): string {
  const names = agent.authors
    .map((author) => author.replace(/<[^>]*>/gu, "").trim())
    .filter((author) => author !== "" && !author.includes("@"))
    .slice(0, 3);
  if (names.length > 0) return names.join(", ");
  if (agent.website !== null) {
    try {
      return new URL(agent.website).hostname.replace(/^www\./u, "");
    } catch {
      // fall through
    }
  }
  return "Unknown publisher";
}

export function downloadLabel(url: string, host: string): string {
  const repo = githubRepoOf(url);
  if (repo !== null) return `GitHub release · ${repo}`;
  if (host === "google.com" || host.endsWith(".google.com")) return "Google download";
  return `Download · ${host}`;
}

/** `fast-agent-acp==0.10.1` or `pkg@1.0` shown as the package name. */
const uvPackageName = (spec: string): string => spec.split(/==|@|>=|<=|~=/u)[0] ?? spec;

function describeDistribution(
  agent: RegistryAgent,
  plan: InstallPlan,
  platform: RegistryPlatform | null,
): ProviderCatalogDistribution | null {
  if (plan.kind === "binary") {
    return { kind: "binary", label: downloadLabel(plan.url, plan.host) };
  }
  if (plan.kind === "npm") return { kind: "npm", label: `npm · ${plan.name}` };
  // An unsupported entry still says what it would have been.
  const target = platform === null ? undefined : agent.binary[platform];
  if (target !== undefined) {
    try {
      const url = new URL(target.archive);
      return { kind: "binary", label: downloadLabel(target.archive, url.hostname) };
    } catch {
      return null;
    }
  }
  if (agent.npm !== null) {
    return { kind: "npm", label: `npm · ${agent.npm.name ?? agent.npm.spec}` };
  }
  if (agent.uvx !== null) return { kind: "uvx", label: `uv · ${uvPackageName(agent.uvx.spec)}` };
  return null;
}

function costOf(overlay: CatalogOverlayEntry | undefined): ProviderCatalogCost {
  const cost = overlay?.cost;
  return cost === undefined
    ? UNKNOWN_COST
    : { kind: cost.kind, label: cost.label, detail: cost.detail ?? null };
}

const compareEntries = (left: ProviderCatalogEntry, right: ProviderCatalogEntry): number => {
  if (left.popularRank !== null || right.popularRank !== null) {
    if (left.popularRank === null) return 1;
    if (right.popularRank === null) return -1;
    if (left.popularRank !== right.popularRank) return left.popularRank - right.popularRank;
  }
  return left.name.localeCompare(right.name, "en", { sensitivity: "base" });
};

function addedOf(
  added: ReadonlyMap<string, string> | undefined,
  catalogId: string,
): ProviderCatalogEntry["added"] {
  const instanceId = added?.get(catalogId);
  return instanceId === undefined ? null : { instanceId: ProviderInstanceId.make(instanceId) };
}

/**
 * Entries in display order: Popular by rank, then everything else A to Z.
 * The caller groups them; the order only has to be stable.
 */
export function buildCatalogEntries(input: BuildCatalogInput): ProviderCatalogEntry[] {
  const iconUrlFor = input.iconUrlFor ?? defaultIconUrlFor;
  const builtIns = input.builtIns ?? BUILT_IN_DESCRIPTORS;
  const registryAgents = new Map((input.registry?.agents ?? []).map((agent) => [agent.id, agent]));
  const duplicateIds = new Set(
    builtIns.flatMap((builtIn) => (builtIn.registryId === null ? [] : [builtIn.registryId])),
  );
  const entries: ProviderCatalogEntry[] = [];

  for (const builtIn of builtIns) {
    const catalogId = builtInCatalogId(builtIn.driver);
    const overlay = input.overlay.entries[catalogId];
    if (overlay?.hidden === true) continue;
    const registryCopy =
      builtIn.registryId === null ? undefined : registryAgents.get(builtIn.registryId);
    entries.push({
      catalogId,
      source: "builtIn",
      name: builtIn.name,
      publisher: overlay?.publisher ?? builtIn.publisher,
      description: overlay?.description ?? builtIn.description,
      website: builtIn.website,
      repository: builtIn.repository,
      license: builtIn.license,
      openSource: isOpenSourceLicense(builtIn.license),
      version: builtIn.version ?? null,
      iconUrl: registryCopy?.icon != null ? iconUrlFor(catalogId) : null,
      distribution: builtIn.distribution ?? null,
      downloadBytes: builtIn.downloadBytes ?? null,
      sha256Checked: builtIn.sha256Checked ?? false,
      cost: costOf(overlay),
      signInLabel: overlay?.signInLabel ?? null,
      popularRank: overlay?.popularRank ?? null,
      supported: { ok: true },
      added: addedOf(input.added, catalogId),
    });
  }

  for (const agent of input.registry?.agents ?? []) {
    if (duplicateIds.has(agent.id)) continue;
    const overlay = input.overlay.entries[agent.id];
    if (overlay?.hidden === true) continue;
    const plan = resolveInstallPlan(agent, {
      platform: input.platform,
      ...(input.nodeAvailable === undefined ? {} : { nodeAvailable: input.nodeAvailable }),
      overlay,
    });
    const platformTarget = input.platform === null ? undefined : agent.binary[input.platform];
    const sizeUrl = plan.kind === "binary" ? plan.url : platformTarget?.archive;
    entries.push({
      catalogId: agent.id,
      source: "registry",
      name: agent.name,
      publisher: overlay?.publisher ?? publisherOf(agent),
      description: overlay?.description ?? agent.description,
      website: agent.website,
      repository: agent.repository,
      license: agent.license ?? "unknown",
      openSource: isOpenSourceLicense(agent.license),
      version: agent.version,
      iconUrl: agent.icon === null ? null : iconUrlFor(agent.id),
      distribution: describeDistribution(agent, plan, input.platform),
      downloadBytes:
        plan.kind === "npm" || sizeUrl === undefined ? null : (input.sizes?.get(sizeUrl) ?? null),
      sha256Checked: plan.kind === "binary",
      cost: costOf(overlay),
      signInLabel: overlay?.signInLabel ?? null,
      popularRank: overlay?.popularRank ?? null,
      supported: plan.kind === "unsupported" ? { ok: false, reason: plan.reason } : { ok: true },
      added: addedOf(input.added, agent.id),
    });
  }

  return entries.toSorted(compareEntries);
}

/**
 * The registry agent whose icon and metadata a catalogue id stands for. A
 * built-in resolves to its registry copy; an unknown id resolves to null.
 */
export function registryAgentForCatalogId(
  catalogId: string,
  registry: ParsedRegistry | null,
  builtIns: ReadonlyArray<BuiltInDescriptor> = BUILT_IN_DESCRIPTORS,
): RegistryAgent | null {
  if (registry === null) return null;
  const builtIn = builtIns.find((candidate) => builtInCatalogId(candidate.driver) === catalogId);
  const registryId = builtIn !== undefined ? builtIn.registryId : catalogId;
  return registryId === null
    ? null
    : (registry.agents.find((agent) => agent.id === registryId) ?? null);
}
