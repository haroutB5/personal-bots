import {
  type ModelSelection,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import * as DateTime from "effect/DateTime";

import {
  botActiveModelLabel,
  botActiveModelShortLabel,
  botModelLabel,
  botModelShortLabel,
  fallbackNoteLabel,
} from "./botModelLabel";
import { taskCardBotLine } from "./botSummaries";

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
    model("claude-sonnet-5-5", "Claude Sonnet 5.5", [
      select("effort", [...EFFORTS, ["max", "Max"]]),
    ]),
    model("claude-haiku-4-5", "Claude Haiku 4.5"),
    model("claude-opus-5-5-1m", "Claude Opus 5.5 (1M context)", [select("effort", EFFORTS)]),
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
    model("opencode/muse-spark-1.3-contributor-free", "Muse Spark 1.3 Free", [
      select("variant", [...EFFORTS, ["minimal", "Minimal"]]),
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
    ).toBe("Muse Spark 1.3 Free extra high");
  });

  it("falls back to the id only when no name is known", () => {
    expect(
      botModelLabel(selection("claudeAgent", "claude-mystery-9", [["effort", "low"]]), providers),
    ).toBe("claude-mystery-9 low");
    expect(botModelLabel(selection("codex", "gpt-6-luna"), [])).toBe("gpt-6-luna");
    expect(botModelLabel(selection("codex", ""), providers)).toBeNull();
  });
});

describe("botModelShortLabel", () => {
  const short = (
    instanceId: string,
    modelSlug: string,
    options: ReadonlyArray<readonly [string, string]> = [],
  ) => botModelShortLabel(selection(instanceId, modelSlug, options), providers);

  it("abbreviates each Claude effort to L, M, H, X or Max", () => {
    expect(short("claudeAgent", "claude-opus-5-5", [["effort", "low"]])).toBe("Opus 5.5 · L");
    expect(short("claudeAgent", "claude-opus-5-5", [["effort", "medium"]])).toBe("Opus 5.5 · M");
    expect(short("claudeAgent", "claude-sonnet-5-5", [["effort", "high"]])).toBe("Sonnet 5.5 · H");
    expect(short("claudeAgent", "claude-opus-5-5", [["effort", "xhigh"]])).toBe("Opus 5.5 · X");
    expect(short("claudeAgent", "claude-sonnet-5-5", [["effort", "max"]])).toBe("Sonnet 5.5 · Max");
  });

  it("shows only the model when no effort is set", () => {
    expect(short("claudeAgent", "claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(short("claudeAgent", "claude-sonnet-5", [["contextWindow", "1m"]])).toBe("Sonnet 5");
    expect(short("claudeAgent", "claude-opus-5-5", [["effort", ""]])).toBe("Opus 5.5");
  });

  it("drops Free and a context-window suffix, and reads Codex and OpenCode efforts", () => {
    expect(short("codex", "gpt-6-astra", [["reasoningEffort", "medium"]])).toBe("GPT-6 Astra · M");
    expect(
      short("opencode", "opencode/muse-spark-1.3-contributor-free", [["variant", "xhigh"]]),
    ).toBe("Muse Spark 1.3 · X");
    expect(short("claudeAgent", "claude-opus-5-5-1m", [["effort", "high"]])).toBe("Opus 5.5 · H");
  });

  it("leaves out an effort it has no abbreviation for", () => {
    expect(
      short("opencode", "opencode/muse-spark-1.3-contributor-free", [["variant", "minimal"]]),
    ).toBe("Muse Spark 1.3");
  });

  it("keeps the raw id for a model the provider does not list, and is null without one", () => {
    expect(short("claudeAgent", "claude-mystery-9", [["effort", "high"]])).toBe(
      "claude-mystery-9 · H",
    );
    expect(botModelShortLabel(selection("codex", "gpt-6-luna"), [])).toBe("gpt-6-luna");
    expect(botModelShortLabel(selection("codex", ""), providers)).toBeNull();
  });
});

describe("a bot on its fallback model", () => {
  const home = selection("codex", "gpt-6-astra", [["reasoningEffort", "medium"]]);
  const fallbackModel = selection("claudeAgent", "claude-sonnet-5-5", [
    ["effort", "high"],
    ["contextWindow", "1m"],
  ]);
  const NOW = Date.parse("2026-09-27T10:00:00.000Z");
  const onFallback = (resetAt?: string) =>
    ({
      modelSelection: home,
      fallbackActive: {
        modelSelection: fallbackModel,
        since: DateTime.makeUnsafe("2026-09-27T09:00:00.000Z"),
        ...(resetAt === undefined ? {} : { resetAt: DateTime.makeUnsafe(resetAt) }),
        fromProvider: "Codex",
      },
    }) as never;
  const atHome = { modelSelection: home } as never;

  it("labels a bot on its own model exactly as before", () => {
    expect(botActiveModelShortLabel(atHome, providers)).toBe("GPT-6 Astra · M");
    expect(botActiveModelLabel(atHome, providers)).toBe("GPT-6 Astra medium");
    expect(fallbackNoteLabel(atHome)).toBeNull();
  });

  it("names the fallback model and marks the short label", () => {
    expect(botActiveModelShortLabel(onFallback(), providers)).toBe("Sonnet 5.5 · H · fallback");
  });

  it("says why and until when in the long label, in the given zone", () => {
    const bot = onFallback("2026-09-27T14:30:00.000Z");
    expect(fallbackNoteLabel(bot, NOW, "UTC")).toBe(
      "on fallback until about 14:30 (Codex usage limit)",
    );
    expect(botActiveModelLabel(bot, providers, NOW, "UTC")).toBe(
      "Sonnet 5.5 high, on fallback until about 14:30 (Codex usage limit)",
    );
    expect(fallbackNoteLabel(bot, NOW, "Asia/Tokyo")).toContain("23:30");
  });

  it("adds the weekday when the reset is not today", () => {
    expect(fallbackNoteLabel(onFallback("2026-09-29T08:05:00.000Z"), NOW, "UTC")).toBe(
      "on fallback until about Tue 08:05 (Codex usage limit)",
    );
  });

  it("marks the task card's bot line too", () => {
    expect(taskCardBotLine(onFallback(), providers)).toBe("Sonnet 5.5 · H · fallback");
    expect(taskCardBotLine(atHome, providers)).toBe("GPT-6 Astra · M");
  });

  it("leaves the time out when the provider gave no reset", () => {
    expect(fallbackNoteLabel(onFallback(), NOW, "UTC")).toBe("on fallback (Codex usage limit)");
  });
});
