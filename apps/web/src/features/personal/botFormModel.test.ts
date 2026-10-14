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
  agentModeOfSelection,
  botAgentModeDescriptor,
  isBotProviderSelectable,
  isFallbackDraftValid,
  modelDraftFromSelection,
  modelOptionLabel,
  type ModelDraft,
  modelSelectionsEqual,
  noBotProviderMessage,
  SAME_FAMILY_FALLBACK_HINT,
  sameFamilyFallbackHint,
  searchModels,
  usesModelSearch,
} from "./botFormModel";
import { resolveBotProvider } from "./botSummaries";

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

  it("never auto-picks Fable, Mythos or Astra: Opus 5.5 first", () => {
    expect(
      defaultModelFor(
        provider("claudeAgent", [
          model({ slug: "claude-fable-5-1", isDefault: true }),
          model({ slug: "claude-mythos-1" }),
          model({ slug: "claude-opus-5-5" }),
          model({ slug: "claude-sonnet-5-5" }),
        ]),
      ),
    ).toBe("claude-opus-5-5");
  });

  it("takes the first model after Codex's Astra default", () => {
    expect(
      defaultModelFor(
        provider("codex", [
          model({ slug: "gpt-6-astra", isDefault: true }),
          model({ slug: "gpt-6.1-sol" }),
          model({ slug: "gpt-6-luna" }),
        ]),
      ),
    ).toBe("gpt-6.1-sol");
  });

  it("skips a legacy model when the provider's default is Astra", () => {
    expect(
      defaultModelFor(
        provider("codex", [
          model({ slug: "gpt-6-astra", isDefault: true }),
          model({ slug: "gpt-5.4", isLegacy: true }),
          model({ slug: "gpt-6.1-sol" }),
        ]),
      ),
    ).toBe("gpt-6.1-sol");
  });

  it("returns nothing when the only models are the ones it never auto-picks", () => {
    expect(
      defaultModelFor(provider("codex", [model({ slug: "gpt-6-astra", isDefault: true })])),
    ).toBe("");
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

describe("agent mode on the DeepSeek Harness engine", () => {
  const deepseek = provider("deepseek", [
    model({
      slug: "deepseek-flash",
      capabilities: createModelCapabilities({
        optionDescriptors: [
          select("effort", ["low", "high", "max"]),
          {
            id: "agentMode",
            label: "Agent mode",
            type: "select" as const,
            options: [
              { id: "standard", label: "Standard", isDefault: true },
              { id: "code", label: "Code" },
              { id: "minimal", label: "Minimal" },
            ],
          },
        ],
      }),
    }),
  ]);

  it("offers the picker only where the model has the option", () => {
    expect(botAgentModeDescriptor(deepseek, "deepseek-flash")?.options.map((o) => o.id)).toEqual([
      "standard",
      "code",
      "minimal",
    ]);
    // The Claude Code engine hands the same model no such option.
    const claudeEngine = provider("deepseek", [
      model({
        slug: "deepseek-flash",
        capabilities: createModelCapabilities({
          optionDescriptors: [select("effort", ["low", "high", "max"])],
        }),
      }),
    ]);
    expect(botAgentModeDescriptor(claudeEngine, "deepseek-flash")).toBeNull();
  });

  it("saves the chosen mode, and drops one the model does not offer", () => {
    const draft: ModelDraft = {
      instanceId: "deepseek",
      model: "deepseek-flash",
      effort: "high",
      contextWindow: "",
      agentMode: "code",
    };
    expect(buildModelSelection(draft, deepseek, null).options).toEqual([
      { id: "effort", value: "high" },
      { id: "agentMode", value: "code" },
    ]);
    const unknown: ModelDraft = { ...draft, agentMode: "creator" };
    expect(buildModelSelection(unknown, deepseek, null).options).toEqual([
      { id: "effort", value: "high" },
    ]);
    // A saved mode round-trips through the draft.
    const saved = buildModelSelection(draft, deepseek, null);
    expect(modelDraftFromSelection(saved).agentMode).toBe("code");
    expect(agentModeOfSelection(saved)).toBe("code");
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
    expect(readyProvider("deepseek")).toSatisfy(isBotProviderSelectable);
    for (const driver of ["cursor", "grok", "antigravity", "someFutureProvider"]) {
      expect(isBotProviderSelectable(readyProvider(driver))).toBe(false);
    }
  });

  it("still excludes a provider that carries instructions but cannot run", () => {
    const disabled = { ...readyProvider("codex"), enabled: false } as ServerProvider;
    expect(isBotProviderSelectable(disabled)).toBe(false);
  });

  // The shape the server really sends for DeepSeek on the harness engine: the
  // DeepSeek driver never sets `availability`, and the pinned harness has no
  // package to look an update up for, so its advisory is `unknown` and carries
  // no update command. A 13 Oct NO-SHIP blamed that advisory for DeepSeek
  // disappearing from the new-bot form; it did not (see the release notes), and
  // this pins the shape so a future change to either cannot take it out
  // silently.
  const dshDeepSeek = (overrides: Partial<ServerProvider>): ServerProvider => {
    const { availability: _unset, ...base } = readyProvider("deepseek", "deepseek");
    return {
      ...base,
      version: "0.2.0-rc.2",
      models: [model({ slug: "deepseek-flash" })],
      versionAdvisory: {
        status: "unknown",
        currentVersion: "0.2.0-rc.2",
        latestVersion: null,
        updateCommand: null,
        canUpdate: false,
        canInstallVersion: false,
        checkedAt: "2026-10-13T23:00:00.000Z",
        message: null,
      },
      smokeCheck: { status: "passed", version: "0.2.0-rc.2" },
      ...overrides,
    } as unknown as ServerProvider;
  };

  it("offers the dsh DeepSeek snapshot, whose advisory is unknown and availability unset", () => {
    const snapshot = dshDeepSeek({});
    expect(snapshot.availability).toBeUndefined();
    expect(isBotProviderSelectable(snapshot)).toBe(true);
    expect(resolveBotProvider("deepseek", [snapshot])).toMatchObject({
      available: true,
      broken: false,
    });
  });

  it("still refuses that snapshot when the server reports it off or unavailable", () => {
    expect(isBotProviderSelectable(dshDeepSeek({ enabled: false }))).toBe(false);
    expect(
      isBotProviderSelectable(
        dshDeepSeek({ availability: "unavailable", unavailableReason: "Driver not registered" }),
      ),
    ).toBe(false);
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
      // The agent mode belongs to the bot's own model, never to its fallback.
      agentMode: "",
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
      agentMode: "",
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
