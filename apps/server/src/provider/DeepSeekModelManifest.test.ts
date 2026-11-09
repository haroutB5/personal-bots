import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDeepSeekModelCatalog } from "@t3tools/provider-deepseek/server";

import { BUNDLED_MODEL_MANIFEST, resolveProviderCatalog } from "./ModelManifest.ts";

describe("the bundled DeepSeek catalog", () => {
  it("resolves to DeepSeek V4.1 Flash as its only model", () => {
    const catalog = resolveDeepSeekModelCatalog(
      resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, ProviderDriverKind.make("deepseek")) ??
        undefined,
    );

    expect(catalog.models.map((entry) => entry.model.slug)).toEqual(["deepseek-flash"]);
    expect(catalog.models[0]?.model.aliases).toContain("deepseek-v4-flash");
    expect(catalog.models[0]?.model.aliases).not.toContain("deepseek-v4-pro");
  });
});
