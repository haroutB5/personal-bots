import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type AcpRegistryPrepareInput,
  type AcpRegistryPrepareResult,
  type AcpRegistrySearchAgent,
  type ProviderInstanceConfig,
  type ProviderTestRunInput,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ProviderCatalogOverlay } from "./overlay.ts";
import { makeProviderCatalogAdapter } from "./ProviderCatalogAdapter.ts";

const agent = (
  overrides: Partial<AcpRegistrySearchAgent> & Pick<AcpRegistrySearchAgent, "id" | "name">,
): AcpRegistrySearchAgent => ({
  version: "0.5.0",
  description: "An ACP agent.",
  authors: ["Example Inc"],
  license: "Apache-2.0",
  website: "https://example.com/agent",
  repository: null,
  icon: null,
  distribution: "npx",
  integrity: "sha256",
  ...overrides,
});

const gemini = agent({ id: "gemini", name: "Gemini CLI", authors: ["Google LLC"] });
const goose = agent({
  id: "goose",
  name: "Goose",
  distribution: "binary",
  integrity: "registry",
});
const cursorCopy = agent({ id: "cursor", name: "Cursor Agent" });

const overlay: ProviderCatalogOverlay = {
  version: 1,
  entries: {
    "builtin:cursor": { popularRank: 1 },
    gemini: {
      cost: { kind: "freeTier", label: "Free with a Google account" },
      signInLabel: "Google account",
      popularRank: 2,
    },
    goose: { hidden: true },
  },
};

const settingsWith = (providerInstances: ServerSettings["providerInstances"]): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances,
});

interface Harness {
  readonly agents: ReadonlyArray<AcpRegistrySearchAgent>;
  readonly settings?: ServerSettings;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly overlay?: ProviderCatalogOverlay;
}

function harness(options: Harness) {
  const prepared: AcpRegistryPrepareInput[] = [];
  const written: Array<{
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
  }> = [];
  const tests: ProviderTestRunInput[] = [];
  const settings = options.settings ?? DEFAULT_SERVER_SETTINGS;
  const adapter = makeProviderCatalogAdapter({
    searchRegistry: () => Effect.succeed({ agents: options.agents }),
    prepareRegistryAgent: (input) =>
      Effect.sync(() => {
        prepared.push(input);
        return {
          agentId: input.agentId,
          version: "0.5.0",
          distribution: "npx",
          prepared: true,
        } satisfies AcpRegistryPrepareResult;
      }),
    getProviders: Effect.succeed(options.providers ?? []),
    getSettings: Effect.succeed(settings),
    setProvider: (input) =>
      Effect.sync(() => {
        written.push(input);
      }),
    refreshProvider: () => Effect.void,
    testRun: (input) =>
      Effect.sync(() => {
        tests.push(input);
      }),
    ...(options.overlay === undefined ? {} : { overlay: options.overlay }),
  });
  return { adapter, prepared, written, tests, settings };
}

describe("provider catalog adapter", () => {
  it("lists built-ins and registry agents in Popular order and drops a duplicate", async () => {
    const { adapter } = harness({
      agents: [gemini, goose, cursorCopy],
      overlay,
      settings: settingsWith({
        [ProviderInstanceId.make("gemini-work")]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "gemini" },
        },
      }),
    });

    const result = await Effect.runPromise(adapter.list({}));

    expect(result.entries.map((entry) => entry.catalogId)).toEqual([
      "builtin:cursor",
      "gemini",
      "builtin:antigravity",
      "builtin:claudeAgent",
      "builtin:codex",
      "builtin:deepseek",
      "builtin:grok",
      "builtin:opencode",
    ]);
    expect(result.entries.find((entry) => entry.catalogId === "gemini")).toEqual({
      catalogId: "gemini",
      source: "registry",
      name: "Gemini CLI",
      publisher: "Google LLC",
      description: "An ACP agent.",
      website: "https://example.com/agent",
      repository: null,
      license: "Apache-2.0",
      openSource: true,
      version: "0.5.0",
      iconUrl: null,
      distribution: { kind: "npm", label: "npm package" },
      downloadBytes: null,
      sha256Checked: true,
      cost: { kind: "freeTier", label: "Free with a Google account", detail: null },
      signInLabel: "Google account",
      popularRank: 2,
      supported: { ok: true },
      added: { instanceId: "gemini-work" },
    });
    expect(result.entries.find((entry) => entry.catalogId === "builtin:cursor")).toMatchObject({
      source: "builtIn",
      popularRank: 1,
      publisher: "Cursor",
      license: "proprietary",
      openSource: false,
      distribution: null,
      downloadBytes: null,
      sha256Checked: false,
      cost: { kind: "unknown", label: "Price not listed", detail: null },
      added: null,
    });
    expect(result.registryStale).toBe(false);
    expect(result.registryFetchedAt).toBeNull();
  });

  it("keeps built-ins when the registry is unreachable", async () => {
    const adapter = makeProviderCatalogAdapter({
      searchRegistry: () => Effect.fail(new Error("offline")),
      prepareRegistryAgent: () => Effect.die("unused"),
      getProviders: Effect.succeed([]),
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      setProvider: () => Effect.die("unused"),
      refreshProvider: () => Effect.void,
      testRun: () => Effect.die("unused"),
    });

    const result = await Effect.runPromise(adapter.list({}));

    expect(result.entries).toHaveLength(7);
    expect(result.entries.every((entry) => entry.source === "builtIn")).toBe(true);
    expect(result.registryStale).toBe(true);
  });

  it("reports downloadBytes null and checks sha256 only when the registry says sha256", async () => {
    const { adapter } = harness({ agents: [gemini, { ...goose, id: "legacy", name: "Legacy" }] });

    const checked = await Effect.runPromise(adapter.installFacts({ catalogId: "gemini" }));
    const unchecked = await Effect.runPromise(adapter.installFacts({ catalogId: "legacy" }));

    expect(checked).toEqual({
      catalogId: "gemini",
      version: "0.5.0",
      distribution: { kind: "npm", label: "npm package" },
      downloadBytes: null,
      requiredBytes: 600 * 1024 * 1024,
      sha256Checked: true,
      host: null,
      runsInstallScripts: true,
    });
    expect(unchecked.sha256Checked).toBe(false);
    expect(unchecked.downloadBytes).toBeNull();
    expect(unchecked.distribution).toEqual({ kind: "binary", label: "Download" });
    expect(unchecked.requiredBytes).toBe(1536 * 1024 * 1024);
    expect(unchecked.runsInstallScripts).toBe(false);
  });

  it("prepares a registry agent and writes one provider instance", async () => {
    const { adapter, prepared, written } = harness({ agents: [gemini] });

    const result = await Effect.runPromise(adapter.add({ catalogId: "gemini" }));

    expect(result).toEqual({ instanceId: "gemini" });
    expect(prepared).toEqual([{ agentId: "gemini" }]);
    expect(written).toEqual([
      {
        instanceId: "gemini",
        instance: {
          driver: "acpRegistry",
          displayName: "Gemini CLI",
          enabled: true,
          config: { agentId: "gemini" },
        },
      },
    ]);
  });

  it("reuses the instance already created from a catalogue entry", async () => {
    const { adapter, prepared, written } = harness({
      agents: [gemini],
      settings: settingsWith({
        [ProviderInstanceId.make("gemini-work")]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "gemini" },
        },
      }),
    });

    const result = await Effect.runPromise(adapter.add({ catalogId: "gemini" }));

    expect(result).toEqual({ instanceId: "gemini-work" });
    expect(prepared).toEqual([]);
    expect(written).toEqual([]);
  });

  it("forwards the test model and returns an empty verdict", async () => {
    const { adapter, tests } = harness({ agents: [] });

    const result = await Effect.runPromise(
      adapter.testRun({ instanceId: ProviderInstanceId.make("gemini"), model: "gemini-2.5-pro" }),
    );

    expect(result).toEqual({});
    expect(tests).toEqual([
      { instanceId: ProviderInstanceId.make("gemini"), model: "gemini-2.5-pro" },
    ]);
  });

  it("returns the server settings the phone renders", async () => {
    const settings = settingsWith({
      [ProviderInstanceId.make("gemini-work")]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        enabled: true,
        config: { agentId: "gemini" },
      },
    });
    const { adapter } = harness({ agents: [], settings });

    const result = await Effect.runPromise(adapter.getSettings);

    expect(result).toEqual(settings);
  });
});
