import { describe, expect, it } from "vite-plus/test";

import type {
  ProviderCatalog,
  ProviderCatalogModel,
} from "@t3tools/provider-core/server/ModelCatalog";

import {
  canonicalizeDeepSeekModelId,
  deepSeekCatalogHasModel,
  getDeepSeekCatalogModelCapabilities,
  isDeepSeekFlashId,
  resolveDeepSeekCatalogApiModelId,
  resolveDeepSeekCatalogEffort,
  resolveDeepSeekModelCatalog,
  resolveDeepSeekModelSlug,
  scopeDeepSeekModelCatalog,
} from "./catalog.ts";

const flashModel: ProviderCatalogModel = {
  slug: "deepseek-flash",
  name: "DeepSeek V4.1 Flash",
  aliases: ["deepseek-v4-flash", "vision-exp", "flash"],
  status: "current",
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
          { id: "max", label: "Max" },
        ],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [{ id: "1m", label: "1M", isDefault: true }],
      },
    ],
  },
  adapter: {},
  profileAdapter: {
    claudeCode: {
      modelSuffixes: { contextWindow: { "1m": "[1m]" } },
      contextWindowTokens: { "1m": 1000000 },
    },
  },
};

const catalog: ProviderCatalog = {
  defaultChatModel: "deepseek-flash",
  models: [flashModel],
};

describe("DeepSeek model catalog", () => {
  it("resolves the Flash-only catalog from the manifest rows", () => {
    const resolved = resolveDeepSeekModelCatalog(catalog);
    expect(resolved.models.map((entry) => entry.model.slug)).toEqual(["deepseek-flash"]);
    expect(resolved.models[0]?.model.name).toBe("DeepSeek V4.1 Flash");
    expect(resolved.models[0]?.model.aliases).toContain("deepseek-v4-flash");
    expect(resolved.models[0]?.model.aliases).not.toContain("deepseek-v4-pro");
  });

  it("canonicalizes only documented Flash aliases", () => {
    expect(canonicalizeDeepSeekModelId("deepseek-flash")).toBe("deepseek-flash");
    expect(canonicalizeDeepSeekModelId("deepseek-v4-flash")).toBe("deepseek-flash");
    expect(canonicalizeDeepSeekModelId("vision-exp")).toBe("deepseek-flash");
    // Never remap Pro or Claude ids: they pass through so the caller rejects them.
    expect(canonicalizeDeepSeekModelId("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(canonicalizeDeepSeekModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("recognizes the Flash id, aliases, and the [1m] suffix rendering", () => {
    expect(isDeepSeekFlashId("deepseek-flash")).toBe(true);
    expect(isDeepSeekFlashId("deepseek-v4-flash")).toBe(true);
    expect(isDeepSeekFlashId("vision-exp")).toBe(true);
    expect(isDeepSeekFlashId("deepseek-flash[1m]")).toBe(true);
    expect(isDeepSeekFlashId("deepseek-v4-pro")).toBe(false);
    expect(isDeepSeekFlashId("")).toBe(false);
  });

  it("resolves slugs through aliases and reports membership", () => {
    const resolved = resolveDeepSeekModelCatalog(catalog);
    expect(resolveDeepSeekModelSlug(resolved, "deepseek-v4-flash")).toBe("deepseek-flash");
    expect(resolveDeepSeekModelSlug(resolved, "vision-exp")).toBe("deepseek-flash");
    expect(deepSeekCatalogHasModel(resolved, "deepseek-flash")).toBe(true);
    expect(deepSeekCatalogHasModel(resolved, "deepseek-v4-pro")).toBe(false);
    expect(deepSeekCatalogHasModel(resolved, "claude-sonnet-5")).toBe(false);
  });

  it("defaults bot effort to high and renders the [1m] API id", () => {
    const resolved = resolveDeepSeekModelCatalog(catalog);
    expect(resolveDeepSeekCatalogEffort(resolved, "deepseek-flash", null)).toBe("high");
    expect(resolveDeepSeekCatalogEffort(resolved, "deepseek-flash", "low")).toBe("low");
    expect(resolveDeepSeekCatalogEffort(resolved, "deepseek-flash", "max")).toBe("max");
    expect(
      resolveDeepSeekCatalogApiModelId(resolved, {
        instanceId: "deepseek",
        model: "deepseek-flash",
      } as never),
    ).toBe("deepseek-flash[1m]");
  });

  it("drops non-Flash custom models instead of appending them", () => {
    const resolved = resolveDeepSeekModelCatalog(catalog);
    const scoped = scopeDeepSeekModelCatalog(resolved, [
      "deepseek-v4-pro",
      "claude-sonnet-5",
      { slug: "my-flash-fork", name: "Fork" },
    ]);
    expect(scoped.models.map((entry) => entry.model.slug)).toEqual(["deepseek-flash"]);
  });

  it("exposes the picker's effort options without Pro or Claude entries", () => {
    const resolved = resolveDeepSeekModelCatalog(catalog);
    const caps = getDeepSeekCatalogModelCapabilities(resolved, "deepseek-flash");
    const effort = (caps.optionDescriptors ?? []).find((descriptor) => descriptor.id === "effort");
    expect(effort?.type).toBe("select");
    if (effort?.type === "select") {
      expect(effort.options.map((option) => option.id)).toEqual(["low", "high", "max"]);
    }
  });
});
