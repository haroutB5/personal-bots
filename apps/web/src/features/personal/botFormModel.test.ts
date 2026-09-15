import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  botEffortDescriptor,
  defaultModelFor,
  modelOptionLabel,
  searchModels,
  usesModelSearch,
} from "./botFormModel";

const select = (id: string, values: ReadonlyArray<string>) => ({
  id,
  label: id,
  type: "select" as const,
  options: values.map((value) => ({ id: value, label: value })),
});

const model = (fields: Partial<ServerProviderModel> & { slug: string }): ServerProviderModel =>
  ({
    name: fields.slug,
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
    ...fields,
  }) as ServerProviderModel;

const provider = (driver: string, models: ReadonlyArray<ServerProviderModel>) =>
  ({ driver: ProviderDriverKind.make(driver), models }) as unknown as ServerProvider;

describe("botEffortDescriptor", () => {
  it("offers OpenCode's reasoning variant as the bot's effort", () => {
    const opencode = provider("opencode", [
      model({
        slug: "opencode/muse-spark-1.3-contributor-free",
        capabilities: createModelCapabilities({
          optionDescriptors: [
            select("variant", ["low", "medium", "high"]),
            select("agent", ["build", "plan"]),
          ],
        }),
      }),
    ]);
    expect(botEffortDescriptor(opencode, "opencode/muse-spark-1.3-contributor-free")?.id).toBe(
      "variant",
    );
  });

  it("keeps Claude's effort and never offers the agent picker", () => {
    const claude = provider("claudeAgent", [
      model({
        slug: "claude-opus-5",
        capabilities: createModelCapabilities({
          optionDescriptors: [select("effort", ["low", "high"])],
        }),
      }),
    ]);
    expect(botEffortDescriptor(claude, "claude-opus-5")?.id).toBe("effort");
    const agentOnly = provider("opencode", [
      model({
        slug: "opencode/a",
        capabilities: createModelCapabilities({ optionDescriptors: [select("agent", ["build"])] }),
      }),
    ]);
    expect(botEffortDescriptor(agentOnly, "opencode/a")).toBeNull();
    expect(botEffortDescriptor(undefined, "x")).toBeNull();
  });
});

describe("defaultModelFor", () => {
  it("uses the provider's own default and otherwise makes the owner pick", () => {
    expect(
      defaultModelFor(
        provider("claudeAgent", [
          model({ slug: "claude-a" }),
          model({ slug: "claude-b", isDefault: true }),
        ]),
      ),
    ).toBe("claude-b");
    // OpenCode names no default: never preselect the alphabetical first (maybe paid) model.
    expect(
      defaultModelFor(provider("opencode", [model({ slug: "openrouter/anthropic/claude" })])),
    ).toBe("");
    expect(defaultModelFor(undefined)).toBe("");
  });
});

describe("searchModels", () => {
  const catalog = [
    model({ slug: "openrouter/aion/aion-2.0", name: "Aion-2.0", subProvider: "OpenRouter" }),
    model({
      slug: "openrouter/meta/muse-spark-1.3",
      name: "Muse Spark 1.3",
      subProvider: "OpenRouter",
    }),
    model({
      slug: "opencode/muse-spark-1.3-contributor-free",
      name: "Muse Spark 1.3 Free",
      subProvider: "OpenCode Zen",
    }),
    model({
      slug: "opencode/muse-spark-1.2-contributor-free",
      name: "Muse Spark 1.2 Free",
      subProvider: "OpenCode Zen",
    }),
    model({ slug: "opencode/big-pickle", name: "Big Pickle", subProvider: "OpenCode Zen" }),
  ];

  it("matches every typed word across name, sub-provider and slug, any case", () => {
    expect(searchModels(catalog, "muse 1.3 free").map((entry) => entry.slug)).toEqual([
      "opencode/muse-spark-1.3-contributor-free",
    ]);
    expect(searchModels(catalog, "ZEN pickle").map((entry) => entry.slug)).toEqual([
      "opencode/big-pickle",
    ]);
    expect(searchModels(catalog, "contributor").length).toBe(2);
  });

  it("puts names that start with the query first, keeping catalogue order otherwise", () => {
    expect(searchModels(catalog, "spark").map((entry) => entry.slug)).toEqual([
      "openrouter/meta/muse-spark-1.3",
      "opencode/muse-spark-1.3-contributor-free",
      "opencode/muse-spark-1.2-contributor-free",
    ]);
    expect(searchModels(catalog, "muse s")[0]?.slug).toBe("openrouter/meta/muse-spark-1.3");
  });

  it("shows nothing for an empty query and caps the list", () => {
    expect(searchModels(catalog, "   ")).toEqual([]);
    expect(searchModels(catalog, "o", 2).length).toBe(2);
  });

  it("only switches to search for long lists", () => {
    expect(usesModelSearch(catalog)).toBe(false);
    expect(usesModelSearch(Array.from({ length: 40 }, (_, i) => model({ slug: `m${i}` })))).toBe(
      true,
    );
  });
});

describe("modelOptionLabel", () => {
  it("adds the sub-provider so same-named models can be told apart", () => {
    expect(modelOptionLabel({ name: "Muse Spark 1.3", subProvider: "OpenCode Zen" })).toBe(
      "Muse Spark 1.3 · OpenCode Zen",
    );
    expect(modelOptionLabel({ name: "Claude Opus 5" })).toBe("Claude Opus 5");
  });
});
