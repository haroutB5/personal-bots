import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { botOffersEco, ecoDraftFromBot, ecoDraftProblem, ecoInput } from "./botFormModel.ts";

const effort = {
  id: "effort",
  label: "effort",
  type: "select" as const,
  options: ["low", "medium", "high"].map((value) => ({ id: value, label: value })),
};
const model = (slug: string): ServerProviderModel =>
  ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: [effort] }),
  }) as ServerProviderModel;
const claude = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  models: [model("claude-opus-5-5"), model("claude-sonnet-5-5"), model("claude-haiku-5-5")],
} as unknown as ServerProvider;
const opus: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};

describe("Eco in the bot form", () => {
  it("is offered for Claude Code bots only", () => {
    expect(botOffersEco(claude)).toBe(true);
    expect(botOffersEco({ ...claude, driver: ProviderDriverKind.make("codex") })).toBe(false);
    expect(botOffersEco(undefined)).toBe(false);
  });

  it("starts off with Sonnet 5.5 High as the builder", () => {
    expect(ecoDraftFromBot(null)).toMatchObject({
      enabled: false,
      model: "claude-sonnet-5-5",
      effort: "high",
    });
    expect(ecoDraftFromBot({ modelSelection: opus })).toMatchObject({
      enabled: false,
      instanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
    });
  });

  it("sends only the switch when the default builder is kept", () => {
    const draft = { ...ecoDraftFromBot(null), enabled: true };
    expect(ecoInput(null, draft, "claudeAgent", [claude])).toEqual({ enabled: true });
    const saved = ecoDraftFromBot({ modelSelection: opus });
    expect(
      ecoInput(
        { enabled: false, modelSelection: { ...opus, model: "claude-sonnet-5-5" } },
        {
          ...saved,
          enabled: false,
        },
        "claudeAgent",
        [claude],
      ),
    ).toBeUndefined();
  });

  it("sends a picked builder on the bot's own provider", () => {
    const draft = { ...ecoDraftFromBot(null), enabled: true, model: "claude-haiku-5-5" };
    expect(ecoInput(null, draft, "claudeAgent", [claude])).toEqual({
      enabled: true,
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-haiku-5-5",
        options: [{ id: "effort", value: "high" }],
      },
    });
  });

  it("blocks a builder that is not cheaper than the bot's own model", () => {
    const draft = { ...ecoDraftFromBot(null), enabled: true };
    const main = (slug: string) => ({ instanceId: "claudeAgent", model: slug });
    expect(ecoDraftProblem(main("claude-haiku-5-5"), draft)).toMatch(/cheaper model/);
    expect(
      ecoDraftProblem(main("claude-opus-5-5"), { ...draft, model: "claude-opus-4-1" }),
    ).toMatch(/cheaper model/);
    expect(ecoDraftProblem(main("claude-opus-5-5"), draft)).toBeNull();
    expect(
      ecoDraftProblem(main("claude-sonnet-5-5"), { ...draft, model: "claude-haiku-5-5" }),
    ).toBeNull();
    // A family with no known price order is left to the owner.
    expect(ecoDraftProblem(main("claude-fable-5-2"), draft)).toBeNull();
  });

  it("asks for the builder's effort when the model offers one", () => {
    const main = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
    const draft = { ...ecoDraftFromBot(null), enabled: true, effort: "" };
    expect(ecoDraftProblem(main, draft, [claude])).toMatch(/effort/);
    expect(ecoDraftProblem(main, { ...draft, effort: "high" }, [claude])).toBeNull();
    const noEffort = {
      ...claude,
      models: [
        {
          ...model("claude-sonnet-5-5"),
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        },
      ],
    } as unknown as ServerProvider;
    expect(ecoDraftProblem(main, draft, [noEffort])).toBeNull();
  });

  it("blocks the bot's own model as the builder", () => {
    const draft = { ...ecoDraftFromBot(null), enabled: true, model: "claude-opus-5-5" };
    expect(ecoDraftProblem({ instanceId: "claudeAgent", model: "claude-opus-5-5" }, draft)).toMatch(
      /cheaper model/,
    );
    expect(
      ecoDraftProblem(
        { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        { ...draft, enabled: false },
      ),
    ).toBeNull();
  });
});
