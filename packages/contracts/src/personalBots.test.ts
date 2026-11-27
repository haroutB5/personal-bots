import { describe, expect, it } from "vite-plus/test";

import type { ModelSelection } from "./modelSelection.ts";
import {
  PERSONAL_BOT_DEFAULT_ANTIGRAVITY_ECO_MODEL,
  PERSONAL_BOT_DEFAULT_ECO_MODEL,
  botEco,
  defaultEcoBuilderModel,
} from "./personalBots.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

describe("personalBots Eco defaults", () => {
  it("defaults Claude planners to Sonnet 5.5 High and carries thinking", () => {
    const planner: ModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "high" },
        { id: "thinking", value: true },
      ],
    };
    expect(defaultEcoBuilderModel(planner)).toEqual({
      instanceId: "claudeAgent",
      model: PERSONAL_BOT_DEFAULT_ECO_MODEL.model,
      options: [
        { id: "effort", value: "high" },
        { id: "thinking", value: true },
      ],
    });
  });

  it("defaults Antigravity/Gemini planners to Gemini 4 Hydrogen High on the planner's instance", () => {
    const planner: ModelSelection = {
      instanceId: ProviderInstanceId.make("antigravity"),
      model: "gemini-4-neon",
      options: [{ id: "effort", value: "high" }],
    };
    expect(defaultEcoBuilderModel(planner)).toEqual({
      instanceId: "antigravity",
      model: PERSONAL_BOT_DEFAULT_ANTIGRAVITY_ECO_MODEL.model,
      options: [{ id: "effort", value: "high" }],
    });
    expect(botEco({ modelSelection: planner })).toEqual({
      enabled: false,
      modelSelection: {
        instanceId: "antigravity",
        model: "gemini-4-hydrogen",
        options: [{ id: "effort", value: "high" }],
      },
    });
    // Explicit driver wins even on a custom instanceId.
    const custom: ModelSelection = {
      instanceId: ProviderInstanceId.make("ag-work"),
      model: "custom-model",
    };
    expect(defaultEcoBuilderModel(custom, "antigravity")).toEqual({
      instanceId: "ag-work",
      model: "gemini-4-hydrogen",
      options: [{ id: "effort", value: "high" }],
    });
  });
});
