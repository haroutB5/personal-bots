import {
  type ModelSelection,
  PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
  type PersonalBotFallback,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  botContextWindowDescriptor,
  botEffortDescriptor,
  botInstructionSupportWarning,
  buildModelSelection,
  defaultModelFor,
  fallbackDraftFromBot,
  fallbackInput,
  isBotProviderSelectable,
  isFallbackDraftValid,
  modelDraftFromSelection,
  modelOptionLabel,
  modelSelectionsEqual,
  noBotProviderMessage,
  SAME_FAMILY_FALLBACK_HINT,
  sameFamilyFallbackHint,
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

describe("botContextWindowDescriptor", () => {
  it("offers the context window only when the model has more than one size", () => {
    const claude = provider("claudeAgent", [
      model({
        slug: "claude-sonnet-5",
        capabilities: createModelCapabilities({
          optionDescriptors: [
            select("effort", ["low", "high"]),
            select("contextWindow", ["200k", "1m"]),
          ],
        }),
      }),
      model({
        slug: "claude-fixed",
        capabilities: createModelCapabilities({
          optionDescriptors: [select("contextWindow", ["200k"])],
        }),
      }),
      model({ slug: "claude-plain" }),
    ]);
    expect(
      botContextWindowDescriptor(claude, "claude-sonnet-5")?.options.map((option) => option.id),
    ).toEqual(["200k", "1m"]);
    expect(botContextWindowDescriptor(claude, "claude-fixed")).toBeNull();
    expect(botContextWindowDescriptor(claude, "claude-plain")).toBeNull();
    expect(botContextWindowDescriptor(undefined, "claude-sonnet-5")).toBeNull();
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

const readyProvider = (driver: string, instanceId = driver) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    availability: "available",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-17T00:00:00.000Z",
    models: [],
  }) as unknown as ServerProvider;

describe("bot provider instruction support", () => {
  // The v1.19.0 defect: a bot could be created on any ready provider, but
  // only the Claude, Codex and OpenCode adapters pass its persona to the
  // model. The other three answered as the raw model, silently.
  it("offers only providers whose adapter carries bot instructions", () => {
    expect(readyProvider("claudeAgent")).toSatisfy(isBotProviderSelectable);
    expect(readyProvider("codex")).toSatisfy(isBotProviderSelectable);
    expect(readyProvider("opencode")).toSatisfy(isBotProviderSelectable);
    for (const driver of ["cursor", "grok", "antigravity", "someFutureProvider"]) {
      expect(isBotProviderSelectable(readyProvider(driver))).toBe(false);
    }
  });

  it("still excludes a provider that carries instructions but cannot run", () => {
    const disabled = { ...readyProvider("codex"), enabled: false } as ServerProvider;
    expect(isBotProviderSelectable(disabled)).toBe(false);
  });

  it("warns in the editor for a bot already saved on a mute provider", () => {
    const warning = botInstructionSupportWarning(readyProvider("grok"), "Grok");
    expect(warning).toContain("Grok does not pass bot instructions");
    expect(warning).toContain("Instructions");
    expect(botInstructionSupportWarning(readyProvider("claudeAgent"), "Claude Code")).toBeNull();
    expect(botInstructionSupportWarning(undefined, "Claude Code")).toBeNull();
  });

  it("does not claim 'no provider is ready' when a ready one is merely mute", () => {
    expect(noBotProviderMessage([readyProvider("grok")])).toContain(
      "don't pass bot instructions to the model",
    );
    expect(noBotProviderMessage([])).toContain("No provider is ready");
  });
});

describe("usage-limit fallback in the bot form", () => {
  const claude = {
    ...provider("claudeAgent", [
      model({
        slug: "claude-sonnet-5-5",
        capabilities: createModelCapabilities({
          optionDescriptors: [
            select("effort", ["low", "medium", "high"]),
            select("contextWindow", ["200k", "1m"]),
          ],
        }),
      }),
      model({
        slug: "claude-opus-5-5",
        capabilities: createModelCapabilities({
          optionDescriptors: [select("effort", ["low", "high"])],
        }),
      }),
    ]),
    instanceId: "claudeAgent",
  } as unknown as ServerProvider;
  const providers = [claude];

  it("starts a bot on the default fallback: on, Sonnet 5.5, high, 1M", () => {
    expect(fallbackDraftFromBot(null)).toEqual({
      enabled: true,
      instanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
      effort: "high",
      contextWindow: "1m",
    });
    expect(
      buildModelSelection(
        modelDraftFromSelection(PERSONAL_BOT_DEFAULT_FALLBACK_MODEL),
        claude,
        null,
      ),
    ).toEqual(PERSONAL_BOT_DEFAULT_FALLBACK_MODEL);
  });

  it("sends the whole fallback on create", () => {
    expect(fallbackInput(null, fallbackDraftFromBot(null), providers)).toEqual({
      enabled: true,
      modelSelection: PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
    });
  });

  it("round trips a saved fallback and sends nothing for an unchanged edit", () => {
    const saved: PersonalBotFallback = {
      enabled: false,
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "low" }],
      } as unknown as ModelSelection,
    };
    const draft = fallbackDraftFromBot({ fallback: saved });
    expect(draft).toEqual({
      enabled: false,
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      effort: "low",
      contextWindow: "",
    });
    expect(fallbackInput(saved, draft, providers)).toBeUndefined();
    // An older server sends no fallback: the default, and still nothing to send.
    expect(fallbackInput(botFallbackOf(undefined), fallbackDraftFromBot({}), providers)).toBe(
      undefined,
    );
  });

  const botFallbackOf = (fallback: PersonalBotFallback | undefined): PersonalBotFallback =>
    fallback ?? { enabled: true, modelSelection: PERSONAL_BOT_DEFAULT_FALLBACK_MODEL };

  it("sends only what changed on edit", () => {
    const saved = botFallbackOf(undefined);
    const base = fallbackDraftFromBot({ fallback: saved });
    expect(fallbackInput(saved, { ...base, enabled: false }, providers)).toEqual({
      enabled: false,
    });
    expect(fallbackInput(saved, { ...base, effort: "medium" }, providers)).toEqual({
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-sonnet-5-5",
        options: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "1m" },
        ],
      },
    });
    const opus = fallbackInput(
      saved,
      { ...base, model: "claude-opus-5-5", effort: "high", contextWindow: "1m" },
      providers,
    );
    // Opus has no context window choice: it is dropped, not carried over.
    expect(opus).toEqual({
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
    });
  });

  it("keeps an untouched choice whole when its provider is not loaded", () => {
    const saved = botFallbackOf(undefined);
    expect(fallbackInput(saved, fallbackDraftFromBot({ fallback: saved }), [])).toBeUndefined();
  });

  it("a fallback that is off needs no model; one that is on does", () => {
    const off = { ...fallbackDraftFromBot(null), enabled: false, instanceId: "", model: "" };
    expect(isFallbackDraftValid(off)).toBe(true);
    expect(fallbackInput(null, off, providers)).toEqual({ enabled: false });
    expect(isFallbackDraftValid({ ...off, enabled: true })).toBe(false);
    expect(isFallbackDraftValid(fallbackDraftFromBot(null))).toBe(true);
  });

  it("compares selections by content, in any option order", () => {
    const left = {
      instanceId: "claudeAgent",
      model: "m",
      options: [
        { id: "effort", value: "high" },
        { id: "contextWindow", value: "1m" },
      ],
    } as unknown as ModelSelection;
    const right = {
      instanceId: "claudeAgent",
      model: "m",
      options: [
        { id: "contextWindow", value: "1m" },
        { id: "effort", value: "high" },
      ],
    } as unknown as ModelSelection;
    expect(modelSelectionsEqual(left, right)).toBe(true);
    expect(modelSelectionsEqual(left, { ...right, model: "n" } as ModelSelection)).toBe(false);
  });

  it("hints when the fallback is on the main model's provider and model family", () => {
    const main = { instanceId: "claudeAgent", model: "claude-sonnet-5" };
    expect(
      sameFamilyFallbackHint(main, { instanceId: "claudeAgent", model: "claude-sonnet-5-5" }),
    ).toBe(SAME_FAMILY_FALLBACK_HINT);
    expect(
      sameFamilyFallbackHint(main, { instanceId: "claudeAgent", model: "claude-opus-5-5" }),
    ).toBeNull();
    expect(
      sameFamilyFallbackHint(main, { instanceId: "codex", model: "claude-sonnet-5" }),
    ).toBeNull();
    expect(
      sameFamilyFallbackHint(
        { instanceId: "codex", model: "gpt-5.5-codex" },
        { instanceId: "codex", model: "gpt-5.3-codex" },
      ),
    ).toBe(SAME_FAMILY_FALLBACK_HINT);
    expect(
      sameFamilyFallbackHint(
        { instanceId: "codex", model: "gpt-5.5-codex" },
        { instanceId: "codex", model: "gpt-5.3-codex-spark" },
      ),
    ).toBeNull();
    expect(sameFamilyFallbackHint(main, { instanceId: "claudeAgent", model: "" })).toBeNull();
  });
});
