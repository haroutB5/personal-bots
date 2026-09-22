import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import type { ModelManifestData } from "./ModelManifest.ts";
import {
  formatClaudeModelName,
  formatClaudeVersionUpgradeMessage,
  mergeDiscoveredClaudeModels,
  normalizeClaudeCatalogEffort,
  parseClaudeModelSlug,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";

/**
 * Test policy: adding or changing a real Claude model in model-manifest.json
 * must not add or update tests here. These synthetic fixtures cover resolver
 * behavior once. Add a test only when Claude adapter semantics change, such
 * as introducing a new compatibility rule or dispatch mapping type.
 */

const manifest = (): ModelManifestData => ({
  version: 1,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "extreme", label: "Extreme", isDefault: true }],
              },
              {
                id: "contextWindow",
                label: "Context Window",
                type: "select",
                options: [{ id: "large", label: "Large", isDefault: true }],
              },
            ],
          },
          adapter: {
            claudeCode: {
              effortMap: { extreme: "high" },
              modelSuffixes: { contextWindow: { large: "[large]" } },
            },
          },
        },
      },
      models: [
        {
          slug: "claude-synthetic-next",
          name: "Claude Synthetic Next",
          aliases: ["synthetic"],
          status: "current",
          profile: "synthetic",
          adapter: { claudeCode: { minVersion: "3.2.0" } },
        },
      ],
    },
  },
});

describe("Claude model catalog", () => {
  it("parses only bare family-version slugs and derives their names", () => {
    assert.deepStrictEqual(parseClaudeModelSlug("claude-opus-5-5"), {
      family: "opus",
      version: [5, 5],
    });
    assert.strictEqual(formatClaudeModelName("claude-opus-5-5"), "Claude Opus 5.5");
    assert.strictEqual(formatClaudeModelName("claude-sonnet-5"), "Claude Sonnet 5");
    assert.strictEqual(parseClaudeModelSlug("claude-haiku-4-5-20251001"), undefined);
    assert.strictEqual(parseClaudeModelSlug("claude-opus-4-20250514-v1"), undefined);
  });

  it("inherits the newest family profile while preserving manifest models and defaults", () => {
    const newestOpus = {
      model: {
        slug: "claude-opus-4-6",
        name: "Manifest Opus",
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "contextWindow",
              label: "Context Window",
              type: "select" as const,
              options: [
                { id: "200k", label: "200k" },
                { id: "1m", label: "1M", isDefault: true },
              ],
            },
          ],
        },
      },
      runtime: {
        modelSuffixes: { contextWindow: { "1m": "[1m]" } },
        contextWindowTokens: { "200k": 200_000, "1m": 1_000_000 },
      },
      compatibility: { minVersion: "2.0.0" },
    };
    const catalog = {
      models: [
        newestOpus,
        {
          model: {
            slug: "claude-opus-4-5",
            name: "Older Opus",
            isCustom: false,
            capabilities: null,
          },
          runtime: {},
          compatibility: {},
        },
        {
          model: {
            slug: "claude-sonnet-5",
            name: "Manifest Sonnet",
            isCustom: false,
            capabilities: null,
          },
          runtime: {},
          compatibility: {},
        },
      ],
    };

    const merged = mergeDiscoveredClaudeModels(catalog, [
      "claude-opus-5-5",
      "claude-opus-4-6",
      "claude-fable-5",
    ]);

    assert.deepStrictEqual(
      merged.models.map((entry) => entry.model.slug),
      ["claude-opus-5-5", "claude-opus-4-6", "claude-opus-4-5", "claude-sonnet-5"],
    );
    const discovered = merged.models[0]!;
    assert.strictEqual(discovered.model.name, "Claude Opus 5.5");
    assert.strictEqual(discovered.model.capabilities, newestOpus.model.capabilities);
    assert.strictEqual(discovered.runtime, newestOpus.runtime);
    assert.deepStrictEqual(discovered.compatibility, {});
    assert.isUndefined(discovered.model.isDefault);
    assert.strictEqual(merged.models[1], newestOpus);
    assert.strictEqual(merged.models[1]!.model.name, "Manifest Opus");
    assert.isTrue(merged.models[1]!.model.isDefault);
  });

  it("ignores discovered models older than the family's newest, whatever the manifest order", () => {
    const entry = (slug: string, isDefault?: true) => ({
      model: {
        slug,
        name: slug,
        isCustom: false,
        capabilities: null,
        ...(isDefault ? { isDefault } : {}),
      },
      runtime: {},
      compatibility: {},
    });
    // Oldest first: "newest" must come from the version, not the position.
    const catalog = { models: [entry("claude-opus-5"), entry("claude-opus-5-5", true)] };

    const merged = mergeDiscoveredClaudeModels(catalog, [
      // Every id a real binary carries: retired generations and stray
      // version-shaped strings. Only something newer than 5.5 may be listed.
      "claude-opus-4",
      "claude-opus-4-8",
      "claude-haiku-3-55",
      "claude-sonnet-4-6",
      "claude-opus-5-6",
    ]);

    assert.deepStrictEqual(
      merged.models.map((model) => model.model.slug),
      ["claude-opus-5-6", "claude-opus-5-5", "claude-opus-5"],
    );
    assert.isTrue(merged.models[1]!.model.isDefault);
  });

  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = resolveClaudeModelCatalog(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.strictEqual(
      formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      "Claude Code v3.1.9 is too old for Claude Synthetic Next. Upgrade to v3.2.0 or newer to access it.",
    );
  });

  it("resolves aliases and declarative adapter mappings", () => {
    const base = manifest();
    const input: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          models: [
            {
              slug: "claude-synthetic-collision",
              name: "Claude Synthetic Collision",
              aliases: ["claude-synthetic-next"],
              status: "current",
            },
            ...base.providers!.claudeAgent!.models,
          ],
        },
      },
    };
    const catalog = resolveClaudeModelCatalog(input);
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-next");
    assert.strictEqual(
      resolveClaudeModelSlug(catalog, "claude-synthetic-next"),
      "claude-synthetic-next",
    );
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "synthetic"), "high");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
      "claude-synthetic-next[large]",
    );
  });

  it("rejects malformed adapter mappings", () => {
    const base = manifest();
    const malformed: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          profiles: {
            ...base.providers!.claudeAgent!.profiles,
            synthetic: {
              ...base.providers!.claudeAgent!.profiles.synthetic!,
              adapter: { claudeCode: { effortMap: { extreme: 123 } } },
            },
          },
        },
      },
    };
    assert.isFalse(hasValidClaudeManifestAdapters(malformed));
  });

  it("appends custom models with their own descriptors and keeps bare slugs opaque", () => {
    const catalog = scopeClaudeModelCatalog(resolveClaudeModelCatalog(manifest()), [
      "synthetic",
      {
        slug: "claude-custom-tuned",
        name: "Tuned",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "gentle", label: "Gentle", isDefault: true },
                { id: "brutal", label: "Brutal" },
              ],
            },
          ],
        },
      },
    ]);

    // The bare custom slug shadows the built-in alias, so it no longer resolves to it.
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "synthetic");
    assert.strictEqual(resolveClaudeCatalogEffort(catalog, "synthetic", "extreme"), undefined);

    // The entry with descriptors resolves user-defined effort ids and passes
    // them through untouched (no effortMap, no model suffix).
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "brutal"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "bogus"),
      "gentle",
    );
    assert.strictEqual(
      normalizeClaudeCatalogEffort(catalog, "brutal", "claude-custom-tuned"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-custom-tuned",
        options: [{ id: "effort", value: "brutal" }],
      }),
      "claude-custom-tuned",
    );
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next", "claude-custom-tuned"],
    );
  });
});
