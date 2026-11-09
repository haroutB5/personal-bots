/**
 * The phone's provider catalogue on the v2 provider stack. A thin adapter over
 * U's ACP registry: the catalogue lists built-ins plus registry agents with the
 * bundled overlay, install facts are derived from the registry entry, add runs
 * the registry prepare then writes one provider instance, and the one-message
 * test goes through the personal provider runner.
 *
 * @module personal/providerCatalog/ProviderCatalogAdapter
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type AcpRegistryPrepareInput,
  type AcpRegistryPrepareResult,
  type AcpRegistrySearchAgent,
  type AcpRegistrySearchInput,
  type AcpRegistrySearchResult,
  type ProviderCatalogAddInput,
  type ProviderCatalogAddResult,
  type ProviderCatalogCost,
  type ProviderCatalogDistribution,
  type ProviderCatalogEntry,
  type ProviderCatalogInstallFactsInput,
  type ProviderCatalogInstallPlan,
  type ProviderCatalogListInput,
  type ProviderCatalogListResult,
  type ProviderInstanceConfig,
  type ProviderTestRunInput,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { ProviderSetupError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  BUNDLED_PROVIDER_CATALOG_OVERLAY,
  type ProviderCatalogOverlay,
  type ProviderCatalogOverlayEntry,
} from "./overlay.ts";

/** 1.5 GiB for an archive whose size is not known, as release 2 did. */
const UNKNOWN_BINARY_REQUIRED_BYTES = 1_536 * 1024 * 1024;
/** A package install needs its cache plus the unpacked tree. */
const PACKAGE_REQUIRED_BYTES = 600 * 1024 * 1024;
const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");
const UNKNOWN_COST: ProviderCatalogCost = {
  kind: "unknown",
  label: "Price not listed",
  detail: null,
};

/**
 * A driver built into hbots. The catalogue id is `builtin:<driver>`, and a
 * registry copy with the same `registryId` is dropped in favour of this row.
 */
export interface BuiltInCatalogDescriptor {
  readonly driver: string;
  readonly name: string;
  readonly publisher: string;
  readonly description: string;
  readonly website: string | null;
  readonly repository: string | null;
  readonly license: string;
  readonly registryId: string | null;
}

export const BUILT_IN_CATALOG: ReadonlyArray<BuiltInCatalogDescriptor> = [
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

export interface ProviderCatalogAdapterDeps {
  readonly searchRegistry: (
    input: AcpRegistrySearchInput,
  ) => Effect.Effect<AcpRegistrySearchResult, unknown>;
  readonly prepareRegistryAgent: (
    input: AcpRegistryPrepareInput,
  ) => Effect.Effect<AcpRegistryPrepareResult, unknown>;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>, unknown>;
  readonly getSettings: Effect.Effect<ServerSettings, unknown>;
  readonly setProvider: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
  }) => Effect.Effect<unknown, unknown>;
  readonly refreshProvider: (instanceId: ProviderInstanceId) => Effect.Effect<unknown, unknown>;
  readonly testRun: (input: ProviderTestRunInput) => Effect.Effect<unknown, unknown>;
  readonly builtIns?: ReadonlyArray<BuiltInCatalogDescriptor>;
  readonly overlay?: ProviderCatalogOverlay;
}

export interface ProviderCatalogAdapterShape {
  readonly list: (
    input: ProviderCatalogListInput,
  ) => Effect.Effect<ProviderCatalogListResult, ProviderSetupError>;
  readonly installFacts: (
    input: ProviderCatalogInstallFactsInput,
  ) => Effect.Effect<ProviderCatalogInstallPlan, ProviderSetupError>;
  readonly add: (
    input: ProviderCatalogAddInput,
  ) => Effect.Effect<ProviderCatalogAddResult, ProviderSetupError>;
  readonly testRun: (
    input: ProviderTestRunInput,
  ) => Effect.Effect<Record<string, never>, ProviderSetupError>;
  readonly getSettings: Effect.Effect<ServerSettings, ProviderSetupError>;
}

interface BuildCatalogInput {
  readonly agents: ReadonlyArray<AcpRegistrySearchAgent>;
  readonly builtIns: ReadonlyArray<BuiltInCatalogDescriptor>;
  readonly overlay: ProviderCatalogOverlay;
  readonly added: ReadonlyMap<string, ProviderInstanceId>;
  readonly providers: ReadonlyArray<ServerProvider>;
}

export function isOpenSourceLicense(license: string | null): boolean {
  if (license === null) return false;
  const text = license.trim().toLowerCase();
  return (
    text !== "" && text !== "unknown" && !/proprietary|commercial|closed|unlicensed/u.test(text)
  );
}

function publisherOf(agent: AcpRegistrySearchAgent): string {
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

function describeDistribution(agent: AcpRegistrySearchAgent): ProviderCatalogDistribution {
  switch (agent.distribution) {
    case "npx":
      return { kind: "npm", label: "npm package" };
    case "uvx":
      return { kind: "uvx", label: "uv package" };
    case "binary":
      return { kind: "binary", label: "Download" };
  }
}

function costOf(overlay: ProviderCatalogOverlayEntry | undefined): ProviderCatalogCost {
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
  added: ReadonlyMap<string, ProviderInstanceId>,
  catalogId: string,
): ProviderCatalogEntry["added"] {
  const instanceId = added.get(catalogId);
  return instanceId === undefined ? null : { instanceId };
}

/**
 * Built-ins and registry agents in display order: Popular by rank, then A to Z.
 * A hidden overlay entry is dropped; a registry copy of a built-in is dropped.
 */
export function buildProviderCatalogEntries(input: BuildCatalogInput): ProviderCatalogEntry[] {
  const duplicateIds = new Set(
    input.builtIns.flatMap((builtIn) => (builtIn.registryId === null ? [] : [builtIn.registryId])),
  );
  const entries: ProviderCatalogEntry[] = [];

  for (const builtIn of input.builtIns) {
    const catalogId = `builtin:${builtIn.driver}`;
    const overlay = input.overlay.entries[catalogId];
    if (overlay?.hidden === true) continue;
    const live = input.providers.find((provider) => provider.driver === builtIn.driver);
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
      version: live?.version ?? null,
      iconUrl: null,
      distribution: null,
      downloadBytes: null,
      sha256Checked: false,
      cost: costOf(overlay),
      signInLabel: overlay?.signInLabel ?? null,
      popularRank: overlay?.popularRank ?? null,
      supported: { ok: true },
      added: addedOf(input.added, catalogId),
    });
  }

  for (const agent of input.agents) {
    if (duplicateIds.has(agent.id)) continue;
    const overlay = input.overlay.entries[agent.id];
    if (overlay?.hidden === true) continue;
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
      iconUrl: null,
      distribution: describeDistribution(agent),
      downloadBytes: null,
      sha256Checked: agent.integrity === "sha256",
      cost: costOf(overlay),
      signInLabel: overlay?.signInLabel ?? null,
      popularRank: overlay?.popularRank ?? null,
      supported: { ok: true },
      added: addedOf(input.added, agent.id),
    });
  }

  return entries.toSorted(compareEntries);
}

/** Catalogue id to the instance already created from it. */
function addedInstances(settings: ServerSettings): ReadonlyMap<string, ProviderInstanceId> {
  const added = new Map<string, ProviderInstanceId>();
  for (const [id, instance] of Object.entries(settings.providerInstances)) {
    const config = instance.config as { readonly agentId?: unknown } | undefined;
    if (
      instance.driver === ACP_REGISTRY_DRIVER &&
      typeof config?.agentId === "string" &&
      config.agentId.length > 0
    ) {
      added.set(config.agentId, ProviderInstanceId.make(id));
      continue;
    }
    added.set(`builtin:${instance.driver}`, ProviderInstanceId.make(id));
  }
  return added;
}

function instanceFor(
  settings: ServerSettings,
  entry: ProviderCatalogEntry,
): ProviderInstanceId | null {
  for (const [id, instance] of Object.entries(settings.providerInstances)) {
    if (entry.source === "builtIn") {
      if (instance.driver === entry.catalogId.slice("builtin:".length)) {
        return ProviderInstanceId.make(id);
      }
      continue;
    }
    const config = instance.config as { readonly agentId?: unknown } | undefined;
    if (instance.driver === ACP_REGISTRY_DRIVER && config?.agentId === entry.catalogId) {
      return ProviderInstanceId.make(id);
    }
  }
  return null;
}

function nextInstanceId(settings: ServerSettings, catalogId: string): ProviderInstanceId {
  const raw = catalogId.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^[^a-zA-Z]+/u, "inst_");
  const base = (raw || "agent").slice(0, 60);
  let candidate = base;
  let counter = 2;
  while ((settings.providerInstances as Record<string, unknown>)[candidate] !== undefined) {
    candidate = `${base}_${counter++}`;
  }
  return ProviderInstanceId.make(candidate);
}

function detailOf(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  const text = String(cause);
  return text.length > 0 ? text : "Unknown provider catalogue failure.";
}

function setupError(
  instanceId: ProviderInstanceId,
  operation: string,
  detail: string,
): ProviderSetupError {
  return new ProviderSetupError({ instanceId, operation, detail });
}

export function makeProviderCatalogAdapter(
  deps: ProviderCatalogAdapterDeps,
): ProviderCatalogAdapterShape {
  const builtIns = deps.builtIns ?? BUILT_IN_CATALOG;
  const overlay = deps.overlay ?? BUNDLED_PROVIDER_CATALOG_OVERLAY;
  const catalogFailed = (operation: string) => (cause: unknown) =>
    setupError(ProviderInstanceId.make("catalog"), operation, detailOf(cause));

  const list = (
    _input: ProviderCatalogListInput,
  ): Effect.Effect<ProviderCatalogListResult, ProviderSetupError> =>
    Effect.gen(function* () {
      const settings = yield* deps.getSettings.pipe(
        Effect.orElseSucceed((): ServerSettings | null => null),
      );
      const providers = yield* deps.getProviders.pipe(
        Effect.orElseSucceed((): ReadonlyArray<ServerProvider> => []),
      );
      const searched = yield* deps.searchRegistry({ query: "", limit: 512 }).pipe(Effect.option);
      const agents = Option.isSome(searched) ? searched.value.agents : [];
      const entries = buildProviderCatalogEntries({
        agents,
        builtIns,
        overlay,
        added: settings === null ? new Map() : addedInstances(settings),
        providers,
      });
      return {
        entries,
        registryFetchedAt: null,
        registryStale: Option.isNone(searched),
      } satisfies ProviderCatalogListResult;
    });

  const installFacts = (
    input: ProviderCatalogInstallFactsInput,
  ): Effect.Effect<ProviderCatalogInstallPlan, ProviderSetupError> =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make(input.catalogId);
      const listed = yield* list({});
      const entry = listed.entries.find((candidate) => candidate.catalogId === input.catalogId);
      if (entry === undefined) {
        return yield* setupError(
          id,
          "catalog-facts",
          `Catalogue entry '${input.catalogId}' was not found.`,
        );
      }
      if (entry.source === "builtIn" || entry.distribution === null) {
        return yield* setupError(
          id,
          "catalog-facts",
          `${entry.name} is built into hbots and needs no download.`,
        );
      }
      if (entry.version === null) {
        return yield* setupError(id, "catalog-facts", `${entry.name} does not report a version.`);
      }
      return {
        catalogId: entry.catalogId,
        version: entry.version,
        distribution: entry.distribution,
        downloadBytes: null,
        requiredBytes:
          entry.distribution.kind === "binary"
            ? UNKNOWN_BINARY_REQUIRED_BYTES
            : PACKAGE_REQUIRED_BYTES,
        sha256Checked: entry.sha256Checked,
        host: null,
        runsInstallScripts: entry.distribution.kind !== "binary",
      } satisfies ProviderCatalogInstallPlan;
    });

  const add = (
    input: ProviderCatalogAddInput,
  ): Effect.Effect<ProviderCatalogAddResult, ProviderSetupError> =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make(input.catalogId);
      const listed = yield* list({});
      const entry = listed.entries.find((candidate) => candidate.catalogId === input.catalogId);
      if (entry === undefined) {
        return yield* setupError(
          id,
          "catalog-add",
          `Catalogue entry '${input.catalogId}' was not found.`,
        );
      }
      const settings = yield* deps.getSettings.pipe(Effect.mapError(catalogFailed("catalog-add")));
      const existing = instanceFor(settings, entry);
      if (existing !== null) return { instanceId: existing };
      let driver: ProviderDriverKind;
      let config: Readonly<Record<string, unknown>>;
      if (entry.source === "builtIn") {
        driver = ProviderDriverKind.make(entry.catalogId.slice("builtin:".length));
        config = {};
      } else {
        yield* deps
          .prepareRegistryAgent({ agentId: entry.catalogId })
          .pipe(Effect.mapError(catalogFailed("catalog-add")));
        driver = ACP_REGISTRY_DRIVER;
        config = { agentId: entry.catalogId };
      }
      const instanceId = nextInstanceId(settings, entry.catalogId);
      yield* deps
        .setProvider({
          instanceId,
          instance: { driver, displayName: entry.name, enabled: true, config },
        })
        .pipe(Effect.mapError(catalogFailed("catalog-add")));
      yield* deps.refreshProvider(instanceId).pipe(Effect.ignore);
      return { instanceId };
    });

  const testRun = (
    input: ProviderTestRunInput,
  ): Effect.Effect<Record<string, never>, ProviderSetupError> =>
    deps.testRun(input).pipe(
      Effect.mapError((cause) => setupError(input.instanceId, "test-run", detailOf(cause))),
      Effect.as({}),
    );

  const getSettings: Effect.Effect<ServerSettings, ProviderSetupError> = deps.getSettings.pipe(
    Effect.mapError(catalogFailed("get-settings")),
  );

  return { list, installFacts, add, testRun, getSettings };
}
