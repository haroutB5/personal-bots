import {
  type ModelSelection,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { botModelLabel } from "./botModelLabel";

const select = (id: string, options: ReadonlyArray<readonly [string, string]>) => ({
  id,
  label: id,
  type: "select" as const,
  options: options.map(([value, label]) => ({ id: value, label })),
});

const EFFORTS = [
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra High"],
] as const;

const model = (
  slug: string,
  name: string,
  optionDescriptors: ReadonlyArray<ReturnType<typeof select>> = [],
): ServerProviderModel =>
  ({
    slug,
    name,
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors }),
  }) as unknown as ServerProviderModel;

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<ServerProviderModel>,
): ServerProvider =>
  ({ instanceId, driver: ProviderDriverKind.make(driver), models }) as unknown as ServerProvider;

const providers = [
  provider("claudeAgent", "claudeAgent", [
    model("claude-opus-5-5", "Claude Opus 5.5", [select("effort", EFFORTS)]),
    model("claude-sonnet-5", "Claude Sonnet 5", [
      select("effort", EFFORTS),
      select("contextWindow", [
        ["200k", "200k"],
        ["1m", "1M"],
      ]),
    ]),
  ]),
  provider("codex", "codex", [
    model("gpt-6-astra", "GPT-6 Astra", [select("reasoningEffort", EFFORTS)]),
  ]),
  provider("opencode", "opencode", [
    model("opencode/muse-spark-1.3-contributor-free", "Muse Spark 1.3", [
      select("variant", EFFORTS),
    ]),
  ]),
];

const selection = (
  instanceId: string,
  modelSlug: string,
  options: ReadonlyArray<readonly [string, string]> = [],
) =>
  ({
    instanceId,
    model: modelSlug,
    ...(options.length > 0 ? { options: options.map(([id, value]) => ({ id, value })) } : {}),
  }) as unknown as ModelSelection;

describe("botModelLabel", () => {
  it("names the model as the picker does, without Claude, plus the effort", () => {
    expect(
      botModelLabel(selection("claudeAgent", "claude-opus-5-5", [["effort", "medium"]]), providers),
    ).toBe("Opus 5.5 medium");
    expect(
      botModelLabel(selection("claudeAgent", "claude-opus-5-5", [["effort", "xhigh"]]), providers),
    ).toBe("Opus 5.5 extra high");
  });

  it("leaves the effort out when the bot keeps the model's default", () => {
    expect(
      botModelLabel(
        selection("claudeAgent", "claude-sonnet-5", [["contextWindow", "1m"]]),
        providers,
      ),
    ).toBe("Sonnet 5");
  });

  it("reads Codex's reasoning effort and OpenCode's variant", () => {
    expect(
      botModelLabel(selection("codex", "gpt-6-astra", [["reasoningEffort", "medium"]]), providers),
    ).toBe("GPT-6 Astra medium");
    expect(
      botModelLabel(
        selection("opencode", "opencode/muse-spark-1.3-contributor-free", [["variant", "xhigh"]]),
        providers,
      ),
    ).toBe("Muse Spark 1.3 extra high");
  });

  it("falls back to the id only when no name is known", () => {
    expect(
      botModelLabel(selection("claudeAgent", "claude-haiku-4-5", [["effort", "low"]]), providers),
    ).toBe("claude-haiku-4-5 low");
    expect(botModelLabel(selection("codex", "gpt-6-luna"), [])).toBe("gpt-6-luna");
    expect(botModelLabel(selection("codex", ""), providers)).toBeNull();
  });
});
