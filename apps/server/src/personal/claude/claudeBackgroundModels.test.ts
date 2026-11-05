import { assert, describe, it } from "@effect/vitest";

import {
  exploreSubagentAgents,
  exploreSubagentModel,
  resolveTextGenerationModel,
  textGenerationBackgroundEffort,
  textGenerationFallbackModel,
} from "./claudeBackgroundModels.ts";

describe("background text jobs", () => {
  it("default to Haiku 5.5 at low effort", () => {
    assert.strictEqual(resolveTextGenerationModel("claude-haiku-5-5", {}), "claude-haiku-5-5");
    assert.strictEqual(textGenerationBackgroundEffort({}), "low");
    assert.strictEqual(textGenerationFallbackModel("claude-haiku-5-5"), "claude-haiku-4-5");
  });

  it("can be pinned back to Haiku 4.5, which then has no retry", () => {
    const env = { PERSONAL_TEXTGEN_MODEL: " claude-haiku-4-5 " };
    const model = resolveTextGenerationModel("claude-haiku-5-5", env);
    assert.strictEqual(model, "claude-haiku-4-5");
    assert.isUndefined(textGenerationFallbackModel(model));
  });

  it("ignore a pin that is not a Claude model, and never touch a model the owner chose", () => {
    assert.strictEqual(
      resolveTextGenerationModel("claude-haiku-5-5", { PERSONAL_TEXTGEN_MODEL: "gpt-6" }),
      "claude-haiku-5-5",
    );
    assert.strictEqual(
      resolveTextGenerationModel("claude-sonnet-5-5", {
        PERSONAL_TEXTGEN_MODEL: "claude-haiku-4-5",
      }),
      "claude-sonnet-5-5",
    );
    assert.isUndefined(textGenerationFallbackModel("claude-sonnet-5-5"));
  });

  it("read the effort from the environment: a level, off, or the default for nonsense", () => {
    assert.strictEqual(textGenerationBackgroundEffort({ PERSONAL_TEXTGEN_EFFORT: "High" }), "high");
    assert.isNull(textGenerationBackgroundEffort({ PERSONAL_TEXTGEN_EFFORT: "off" }));
    assert.isNull(textGenerationBackgroundEffort({ PERSONAL_TEXTGEN_EFFORT: "0" }));
    assert.strictEqual(textGenerationBackgroundEffort({ PERSONAL_TEXTGEN_EFFORT: "turbo" }), "low");
    assert.strictEqual(textGenerationBackgroundEffort({ PERSONAL_TEXTGEN_EFFORT: " " }), "low");
  });
});

describe("the Explore subagent", () => {
  const known = () => true;
  const bot = (mainModel: string | undefined, env: Record<string, string> = {}) =>
    exploreSubagentAgents({ personalBot: true, mainModel, modelKnown: known, env });

  it("gets Haiku 5.5 for a bot on Opus or Sonnet, whatever suffix its model carries", () => {
    assert.strictEqual(bot("claude-sonnet-5-5")?.Explore?.model, "claude-haiku-5-5");
    assert.strictEqual(bot("claude-opus-5-5[1m]")?.Explore?.model, "claude-haiku-5-5");
    assert.strictEqual(bot("claude-opus-4-8")?.Explore?.effort, "medium");
  });

  it("is left alone for any other model, an unknown model, or a plain thread", () => {
    assert.isUndefined(bot("claude-haiku-5-5"));
    assert.isUndefined(bot("claude-fable-5-1"));
    assert.isUndefined(bot("gpt-6-luna"));
    assert.isUndefined(bot(undefined));
    assert.isUndefined(
      exploreSubagentAgents({
        personalBot: false,
        mainModel: "claude-sonnet-5-5",
        modelKnown: known,
        env: {},
      }),
    );
    assert.isUndefined(
      exploreSubagentAgents({
        personalBot: true,
        mainModel: "claude-sonnet-5-5",
        modelKnown: (slug) => slug !== "claude-haiku-5-5",
        env: {},
      }),
    );
  });

  it("has a kill switch, a model setting and an effort setting", () => {
    assert.isUndefined(exploreSubagentModel({ PERSONAL_EXPLORE_MODEL: "off" }));
    assert.isUndefined(bot("claude-sonnet-5-5", { PERSONAL_EXPLORE_MODEL: "false" }));
    assert.strictEqual(
      bot("claude-sonnet-5-5", { PERSONAL_EXPLORE_MODEL: "claude-haiku-4-5" })?.Explore?.model,
      "claude-haiku-4-5",
    );
    assert.strictEqual(
      bot("claude-sonnet-5-5", { PERSONAL_EXPLORE_MODEL: "not-a-model" })?.Explore?.model,
      "claude-haiku-5-5",
    );
    assert.strictEqual(
      bot("claude-sonnet-5-5", { PERSONAL_EXPLORE_EFFORT: "xhigh" })?.Explore?.effort,
      "xhigh",
    );
    assert.isUndefined(
      bot("claude-sonnet-5-5", { PERSONAL_EXPLORE_EFFORT: "off" })?.Explore?.effort,
    );
  });

  it("is read-only and defines nothing but Explore", () => {
    const agents = bot("claude-sonnet-5-5");
    assert.deepStrictEqual(Object.keys(agents ?? {}), ["Explore"]);
    const disallowed = agents?.Explore?.disallowedTools ?? [];
    for (const tool of ["Edit", "Write", "NotebookEdit", "Agent"]) assert.include(disallowed, tool);
    assert.match(agents?.Explore?.prompt ?? "", /never change anything/);
  });
});
