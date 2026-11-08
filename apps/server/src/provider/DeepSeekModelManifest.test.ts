import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BUNDLED_MODEL_MANIFEST, resolveProviderCatalog } from "./ModelManifest.ts";

describe("the bundled DeepSeek catalog", () => {
  it("resolves to DeepSeek V4.1 Flash as its only model", () => {
    const catalog = resolveProviderCatalog(
      BUNDLED_MODEL_MANIFEST,
      ProviderDriverKind.make("deepseek"),
    );

    expect(catalog?.models.map((model) => model.slug)).toEqual(["deepseek-flash"]);
  });
});
