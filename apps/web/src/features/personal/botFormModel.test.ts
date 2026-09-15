import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { botEffortDescriptor, defaultModelFor, modelOptionLabel } from "./botFormModel";

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

describe("modelOptionLabel", () => {
  it("adds the sub-provider so same-named models can be told apart", () => {
    expect(modelOptionLabel({ name: "Muse Spark 1.3", subProvider: "OpenCode Zen" })).toBe(
      "Muse Spark 1.3 · OpenCode Zen",
    );
    expect(modelOptionLabel({ name: "Claude Opus 5" })).toBe("Claude Opus 5");
  });
});
