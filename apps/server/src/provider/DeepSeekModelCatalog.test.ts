import { describe, expect, it } from "@effect/vitest";

import {
  BUNDLED_DEEPSEEK_MODEL_CATALOG,
  canonicalizeDeepSeekModelId,
  DEEPSEEK_FLASH_SLUG,
  deepSeekCatalogHasModel,
  getDeepSeekCatalogModelCapabilities,
  isDeepSeekFlashId,
  resolveDeepSeekCatalogApiModelId,
  resolveDeepSeekCatalogEffort,
  resolveDeepSeekModelCatalog,
  resolveDeepSeekModelSlug,
  scopeDeepSeekModelCatalog,
} from "./DeepSeekModelCatalog.ts";
import { BUNDLED_MODEL_MANIFEST } from "./ModelManifest.ts";

describe("DeepSeekModelCatalog", () => {
  it("resolves the Flash-only catalog from the bundled manifest", () => {
    const catalog = resolveDeepSeekModelCatalog(BUNDLED_MODEL_MANIFEST);
    expect(catalog.models.map((entry) => entry.model.slug)).toEqual(["deepseek-flash"]);
    expect(catalog.models[0]?.model.name).toBe("DeepSeek V4.1 Flash");
    expect(BUNDLED_DEEPSEEK_MODEL_CATALOG.models.map((entry) => entry.model.slug)).toEqual([
      "deepseek-flash",
    ]);
  });

  it("canonicalizes only documented Flash aliases", () => {
    expect(canonicalizeDeepSeekModelId("deepseek-flash")).toBe("deepseek-flash");
    expect(canonicalizeDeepSeekModelId("deepseek-v4-flash")).toBe("deepseek-flash");
    expect(canonicalizeDeepSeekModelId("vision-exp")).toBe("deepseek-flash");
    // Never remap Pro or Claude ids: they pass through so the caller rejects them.
    expect(canonicalizeDeepSeekModelId("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(canonicalizeDeepSeekModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(canonicalizeDeepSeekModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  it("recognizes the Flash id, aliases, and the [1m] suffix rendering", () => {
    expect(isDeepSeekFlashId("deepseek-flash")).toBe(true);
    expect(isDeepSeekFlashId("deepseek-v4-flash")).toBe(true);
    expect(isDeepSeekFlashId("vision-exp")).toBe(true);
    expect(isDeepSeekFlashId("deepseek-flash[1m]")).toBe(true);
    expect(isDeepSeekFlashId("deepseek-v4-pro")).toBe(false);
    expect(isDeepSeekFlashId("claude-haiku-4-5")).toBe(false);
    expect(isDeepSeekFlashId("")).toBe(false);
  });

  it("resolves slugs through aliases and reports membership", () => {
    const catalog = resolveDeepSeekModelCatalog(BUNDLED_MODEL_MANIFEST);
    expect(resolveDeepSeekModelSlug(catalog, "deepseek-v4-flash")).toBe("deepseek-flash");
    expect(resolveDeepSeekModelSlug(catalog, "vision-exp")).toBe("deepseek-flash");
    expect(deepSeekCatalogHasModel(catalog, "deepseek-flash")).toBe(true);
    expect(deepSeekCatalogHasModel(catalog, "deepseek-v4-pro")).toBe(false);
    expect(deepSeekCatalogHasModel(catalog, "claude-sonnet-5")).toBe(false);
  });

  it("defaults bot effort to high and renders the [1m] API id", () => {
    const catalog = resolveDeepSeekModelCatalog(BUNDLED_MODEL_MANIFEST);
    expect(resolveDeepSeekCatalogEffort(catalog, DEEPSEEK_FLASH_SLUG, null)).toBe("high");
    expect(resolveDeepSeekCatalogEffort(catalog, DEEPSEEK_FLASH_SLUG, "low")).toBe("low");
    expect(resolveDeepSeekCatalogEffort(catalog, DEEPSEEK_FLASH_SLUG, "max")).toBe("max");
    const apiId = resolveDeepSeekCatalogApiModelId(catalog, {
      instanceId: "deepseek",
      model: "deepseek-flash",
    } as never);
    expect(apiId).toBe("deepseek-flash[1m]");
  });

  it("drops non-Flash custom models instead of appending them", () => {
    const catalog = resolveDeepSeekModelCatalog(BUNDLED_MODEL_MANIFEST);
    const scoped = scopeDeepSeekModelCatalog(catalog, [
      "deepseek-v4-pro",
      "claude-sonnet-5",
      { slug: "my-flash-fork", name: "Fork" },
    ]);
    expect(scoped.models.map((entry) => entry.model.slug)).toEqual(["deepseek-flash"]);
  });

  it("exposes capabilities for the picker without Pro/Claude entries", () => {
    const catalog = resolveDeepSeekModelCatalog(BUNDLED_MODEL_MANIFEST);
    const caps = getDeepSeekCatalogModelCapabilities(catalog, "deepseek-flash");
    const effort = (caps.optionDescriptors ?? []).find((descriptor) => descriptor.id === "effort");
    expect(effort?.type).toBe("select");
    if (effort?.type === "select") {
      expect(effort.options.map((option) => option.id)).toEqual(["low", "high", "max"]);
    }
  });
});
