import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { isExpensiveSeedModel, seedModelFor } from "./seedModel.ts";

const effort = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
};

const model = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: slug.startsWith("claude-") ? { optionDescriptors: [effort] } : null,
  ...extra,
});

const provider = (models: ReadonlyArray<ReturnType<typeof model>>) =>
  ({ instanceId: "claudeAgent", driver: "claudeAgent", models }) as unknown as ServerProvider;

// The catalog marks Fable as Claude's default, as it did on 28 Sep.
const claude = provider([
  model("claude-fable-5-1", { isDefault: true }),
  model("claude-mythos-1"),
  model("claude-opus-5-5"),
  model("claude-sonnet-5-5"),
]);

describe("seedModelFor", () => {
  it("never seeds onto Fable or Mythos: Opus 5.5 at medium effort first", () => {
    expect(seedModelFor(claude, undefined)).toEqual({
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "medium" }],
    });
  });

  it("takes PERSONAL_SEED_MODEL when the provider lists it, else ignores it", () => {
    expect(seedModelFor(claude, "claude-sonnet-5-5")).toEqual({
      model: "claude-sonnet-5-5",
      options: [{ id: "effort", value: "medium" }],
    });
    expect(seedModelFor(claude, "claude-nonexistent")?.model).toBe("claude-opus-5-5");
    expect(seedModelFor(claude, "  ")?.model).toBe("claude-opus-5-5");
  });

  it("without Opus 5.5 falls back to the default or first current model that is not Fable", () => {
    const noOpus = provider([
      model("claude-fable-5-1", { isDefault: true }),
      model("claude-sonnet-4", { isLegacy: true }),
      model("claude-sonnet-5-5"),
    ]);
    expect(seedModelFor(noOpus, undefined)?.model).toBe("claude-sonnet-5-5");
    const codex = provider([model("gpt-6-luna"), model("gpt-6-astra", { isDefault: true })]);
    expect(seedModelFor(codex, undefined)).toEqual({ model: "gpt-6-astra" });
    expect(
      seedModelFor(provider([model("claude-fable-5-1", { isDefault: true })]), undefined),
    ).toBe(undefined);
  });

  it("recognises the expensive families", () => {
    expect(
      ["claude-fable-5-1", "claude-mythos-1", "Claude-Fable"].map(isExpensiveSeedModel),
    ).toEqual([true, true, true]);
    expect(isExpensiveSeedModel("claude-opus-5-5")).toBe(false);
  });
});
