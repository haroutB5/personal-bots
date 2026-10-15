import {
  type ModelSelection,
  type PersonalBot,
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
  splitModelMarker,
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

/** The agent mode control a DeepSeek instance gets on the harness engine. */
const AGENT_MODES = [
  { id: "standard", label: "Standard", isDefault: true },
  { id: "code", label: "Code" },
  { id: "minimal", label: "Minimal" },
];

const deepseek = provider("deepseek", "deepseek", [
  model("deepseek-flash", "DeepSeek V4.1 Flash", [
    select("effort", EFFORTS),
    { id: "agentMode", label: "Agent mode", type: "select" as const, options: AGENT_MODES },
  ]),
]);

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
  it("marks the agent mode on a DeepSeek Harness bot, and nothing for Standard", () => {
    const withDeepSeek = [...providers, deepseek];
    expect(
      botModelLabel(
        selection("deepseek", "deepseek-flash", [
          ["effort", "high"],
          ["agentMode", "code"],
        ]),
        withDeepSeek,
      ),
    ).toBe("DeepSeek V4.1 Flash high · Code");
    expect(
      botModelShortLabel(
        selection("deepseek", "deepseek-flash", [
          ["effort", "high"],
          ["agentMode", "minimal"],
        ]),
        withDeepSeek,
      ),
    ).toBe("DeepSeek V4.1 Flash · H · Minimal");
    // Standard is the default, so it is never written out.
    expect(
      botModelLabel(
        selection("deepseek", "deepseek-flash", [
          ["effort", "high"],
          ["agentMode", "standard"],
        ]),
        withDeepSeek,
      ),
    ).toBe("DeepSeek V4.1 Flash high");
    expect(
      botModelLabel(
        selection("deepseek", "deepseek-flash", [
          ["effort", "high"],
          ["agentMode", "standard"],
        ]),
        withDeepSeek,
      ),
    ).not.toContain("·");
    // On the Claude Code engine the option is absent and a stray value is
    // simply not shown.
    expect(
      botModelLabel(
        selection("deepseek", "deepseek-flash", [
          ["effort", "high"],
          ["agentMode", "code"],
        ]),
        providers,
      ),
    ).toBe("deepseek-flash high");
    // A provider with no model list at all says nothing either.
    expect(
      botModelLabel(selection("deepseek", "deepseek-flash", [["agentMode", "code"]]), [
        provider("deepseek", "deepseek", []),
      ]),
    ).toBe("deepseek-flash");
  });

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

describe("a bot on the DeepSeek peak switch", () => {
  const home = selection("deepseek", "deepseek-flash");
  const peakModel = selection("claudeAgent", "claude-sonnet-5-5", [
    ["effort", "high"],
    ["contextWindow", "1m"],
  ]);
  const NOW = Date.parse("2026-10-14T09:00:00.000Z");
  const onPeak = (resetAt?: string) =>
    ({
      modelSelection: home,
      fallbackActive: {
        modelSelection: peakModel,
        since: DateTime.makeUnsafe("2026-10-14T08:00:00.000Z"),
        ...(resetAt === undefined ? {} : { resetAt: DateTime.makeUnsafe(resetAt) }),
        fromProvider: "DeepSeek",
        reason: "deepseek_peak",
      },
    }) as never;

  it("says why and until when, in the device's own zone", () => {
    // 10:00 UTC on 14 October is 11:00 in London (BST).
    expect(fallbackNoteLabel(onPeak("2026-10-14T10:00:00.000Z"), NOW, "Europe/London")).toBe(
      "DeepSeek peak until 11:00",
    );
    expect(fallbackNoteLabel(onPeak("2026-10-14T10:00:00.000Z"), NOW, "UTC")).toBe(
      "DeepSeek peak until 10:00",
    );
    // After the 25 October clock change the same UTC window reads an hour earlier.
    expect(
      fallbackNoteLabel(
        onPeak("2026-10-27T10:00:00.000Z"),
        Date.parse("2026-10-27T09:00:00.000Z"),
        "Europe/London",
      ),
    ).toBe("DeepSeek peak until 10:00");
    expect(botActiveModelShortLabel(onPeak("2026-10-14T10:00:00.000Z"), providers)).toBe(
      "Sonnet 5.5 · H · peak",
    );
    expect(
      botActiveModelLabel(onPeak("2026-10-14T10:00:00.000Z"), providers, NOW, "Europe/London"),
    ).toBe("Sonnet 5.5 high, DeepSeek peak until 11:00");
    expect(taskCardBotLine(onPeak("2026-10-14T10:00:00.000Z"), providers)).toBe(
      "Sonnet 5.5 · H · peak",
    );
  });

  it("keeps the window time out of the tight labels and in the long accessible one", () => {
    // The four tight places read this form: rows, the chat header, task cards
    // and the 72px pinned tiles. "· DeepSeek peak until 11:00" was cut there at
    // 390 px, so the visible note is "peak" and the time lives in the long
    // label the same places hand to assistive tech (1.66.44 QA).
    const bot = onPeak("2026-10-14T10:00:00.000Z");
    expect(botActiveModelShortLabel(bot, providers)).toBe("Sonnet 5.5 · H · peak");
    expect(botActiveModelShortLabel(bot, providers)).not.toContain("until");
    expect(fallbackNoteLabel(bot, NOW, "Europe/London")).toBe("DeepSeek peak until 11:00");
    expect(botActiveModelLabel(bot, providers, NOW, "Europe/London")).toContain(
      "DeepSeek peak until 11:00",
    );
  });

  it("never reads as a usage-limit fallback", () => {
    const note = fallbackNoteLabel(onPeak("2026-10-14T10:00:00.000Z"), NOW, "UTC");
    expect(note).not.toContain("fallback");
    expect(note).not.toContain("usage limit");
    expect(botActiveModelShortLabel(onPeak("2026-10-14T10:00:00.000Z"), providers)).not.toContain(
      "fallback",
    );
  });
});

describe("a bot on its model schedule", () => {
  const home = selection("claudeAgent", "claude-sonnet-5-5", [["effort", "high"]]);
  const scheduled = selection("claudeAgent", "claude-opus-5-5", [["effort", "medium"]]);
  const NOW = Date.parse("2026-10-15T23:30:00.000Z");
  const onSchedule = (resetAt?: string) =>
    ({
      modelSelection: home,
      fallbackActive: {
        modelSelection: scheduled,
        since: DateTime.makeUnsafe("2026-10-15T21:00:00.000Z"),
        ...(resetAt === undefined ? {} : { resetAt: DateTime.makeUnsafe(resetAt) }),
        fromProvider: "Claude",
        reason: "schedule",
      },
    }) as never;

  it("says it is the scheduled model and until when, in the device's own zone", () => {
    // 06:00 UTC on 16 October is 07:00 in London (BST).
    expect(fallbackNoteLabel(onSchedule("2026-10-16T06:00:00.000Z"), NOW, "Europe/London")).toBe(
      "Scheduled model until 07:00",
    );
    expect(
      botActiveModelLabel(onSchedule("2026-10-16T06:00:00.000Z"), providers, NOW, "Europe/London"),
    ).toBe("Opus 5.5 medium, Scheduled model until 07:00");
  });

  it("keeps the tight labels short: the model, the effort and sched", () => {
    const bot = onSchedule("2026-10-16T06:00:00.000Z");
    expect(botActiveModelShortLabel(bot, providers)).toBe("Opus 5.5 · M · sched");
    expect(botActiveModelShortLabel(bot, providers)).not.toContain("until");
    expect(taskCardBotLine(bot, providers)).toBe("Opus 5.5 · M · sched");
  });

  it("never reads as a usage-limit fallback or the DeepSeek peak switch", () => {
    const bot = onSchedule("2026-10-16T06:00:00.000Z");
    const note = fallbackNoteLabel(bot, NOW, "UTC");
    expect(note).not.toContain("fallback");
    expect(note).not.toContain("usage limit");
    expect(note).not.toContain("peak");
    expect(botActiveModelShortLabel(bot, providers)).not.toContain("fallback");
    expect(botActiveModelShortLabel(bot, providers)).not.toContain("peak");
  });

  it("leaves the time out when the row names none", () => {
    expect(fallbackNoteLabel(onSchedule(), NOW, "UTC")).toBe("Scheduled model");
  });
});

// 1.66.49 finding 2: a scheduled DeepSeek model in a peak window ran on the
// peak model (Sonnet 5.5 High) while the label read "· sched" with no hint of
// the peak. The server keeps the row's reason `schedule` and swaps the model,
// so the label has to say both.
describe("a bot whose scheduled DeepSeek model is inside a peak window", () => {
  const allProviders = [...providers, deepseek];
  const peakModel = selection("claudeAgent", "claude-sonnet-5-5", [
    ["effort", "high"],
    ["contextWindow", "1m"],
  ]);
  const deepseekSchedule = selection("deepseek", "deepseek-flash", [["effort", "high"]]);
  const NOW = Date.parse("2026-10-14T09:00:00.000Z");
  const onScheduledPeak = (rowModel: ModelSelection) =>
    ({
      modelSelection: selection("deepseek", "deepseek-flash"),
      schedule: { enabled: true, from: "09:00", to: "11:00", modelSelection: deepseekSchedule },
      fallbackActive: {
        modelSelection: rowModel,
        since: DateTime.makeUnsafe("2026-10-14T09:00:00.000Z"),
        resetAt: DateTime.makeUnsafe("2026-10-14T10:00:00.000Z"),
        fromProvider: "DeepSeek",
        reason: "schedule",
      },
    }) as never;

  it("shows the peak in the long label and in the tight one", () => {
    const bot = onScheduledPeak(peakModel);
    expect(fallbackNoteLabel(bot, NOW, "Europe/London")).toBe(
      "Scheduled, DeepSeek peak until 11:00",
    );
    expect(botActiveModelLabel(bot, allProviders, NOW, "Europe/London")).toBe(
      "Sonnet 5.5 high, Scheduled, DeepSeek peak until 11:00",
    );
    // The tight places (rows, header, task cards, tiles) keep the peak word.
    expect(botActiveModelShortLabel(bot, allProviders)).toBe("Sonnet 5.5 · H · peak");
    expect(taskCardBotLine(bot, allProviders)).toBe("Sonnet 5.5 · H · peak");
  });

  it("stays 'Scheduled model' while the row is on the model the schedule names", () => {
    const bot = onScheduledPeak(deepseekSchedule);
    expect(fallbackNoteLabel(bot, NOW, "Europe/London")).toBe("Scheduled model until 11:00");
    expect(botActiveModelShortLabel(bot, allProviders)).toBe("DeepSeek V4.1 Flash · H · sched");
  });

  it("ends the peak note at the earlier of the schedule and the UTC peak window", () => {
    const base = onScheduledPeak(peakModel) as unknown as PersonalBot;
    const withReset = (at: string) => ({
      ...base,
      fallbackActive: { ...base.fallbackActive!, resetAt: DateTime.makeUnsafe(at) },
    });
    expect(fallbackNoteLabel(withReset("2026-10-14T12:00:00Z"), NOW, "Europe/London")).toBe(
      "Scheduled, DeepSeek peak until 11:00",
    );
    expect(fallbackNoteLabel(withReset("2026-10-14T09:30:00Z"), NOW, "Europe/London")).toBe(
      "Scheduled, DeepSeek peak until 10:30",
    );
    expect(
      fallbackNoteLabel(
        withReset("2026-10-27T12:00:00Z"),
        Date.parse("2026-10-27T09:00:00Z"),
        "Europe/London",
      ),
    ).toBe("Scheduled, DeepSeek peak until 10:00");
    expect(
      fallbackNoteLabel(
        withReset("2026-10-14T05:00:00Z"),
        Date.parse("2026-10-14T02:00:00Z"),
        "UTC",
      ),
    ).toBe("Scheduled, DeepSeek peak until 04:00");
  });
});

describe("splitModelMarker", () => {
  it("splits the three markers off the tight label", () => {
    expect(splitModelMarker("Sonnet 5.5 · H · peak")).toEqual({
      base: "Sonnet 5.5 · H",
      marker: "peak",
    });
    expect(splitModelMarker("Opus 5.5 · M · sched")).toEqual({
      base: "Opus 5.5 · M",
      marker: "sched",
    });
    expect(splitModelMarker("Sonnet 5.5 · H · fallback")).toEqual({
      base: "Sonnet 5.5 · H",
      marker: "fallback",
    });
  });

  it("leaves a label with no marker whole", () => {
    expect(splitModelMarker("Opus 5.5 · M")).toEqual({ base: "Opus 5.5 · M", marker: null });
    expect(splitModelMarker("peak")).toEqual({ base: "peak", marker: null });
  });
});
