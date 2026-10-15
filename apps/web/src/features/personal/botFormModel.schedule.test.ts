import type { ModelSelection, PersonalBotSchedule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SCHEDULE_TIME_OPTIONS,
  scheduleDraftFromBot,
  scheduleDraftProblem,
  scheduleHelpLine,
  scheduleInput,
  type ScheduleDraft,
} from "./botFormModel";

const sel = (model: string, effort?: string, context?: string): ModelSelection =>
  ({
    instanceId: "claudeAgent",
    model,
    options: [
      ...(effort === undefined ? [] : [{ id: "effort", value: effort }]),
      ...(context === undefined ? [] : [{ id: "contextWindow", value: context }]),
    ],
  }) as unknown as ModelSelection;

const OPUS = sel("claude-opus-5-5", "medium");
const SONNET = sel("claude-sonnet-5-5", "high", "1m");

const draft = (patch: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  enabled: true,
  from: "22:00",
  to: "07:00",
  instanceId: "claudeAgent",
  model: "claude-sonnet-5-5",
  effort: "high",
  contextWindow: "1m",
  agentMode: "",
  ...patch,
});

describe("schedule form model", () => {
  it("offers every 15 minutes of the day in 24 hour form", () => {
    expect(SCHEDULE_TIME_OPTIONS).toHaveLength(96);
    expect(SCHEDULE_TIME_OPTIONS[0]).toBe("00:00");
    expect(SCHEDULE_TIME_OPTIONS[1]).toBe("00:15");
    expect(SCHEDULE_TIME_OPTIONS[88]).toBe("22:00");
    expect(SCHEDULE_TIME_OPTIONS[95]).toBe("23:45");
    expect(new Set(SCHEDULE_TIME_OPTIONS).size).toBe(96);
  });

  it("starts off, 22:00 to 07:00, on Sonnet 5.5 High for a new bot", () => {
    expect(scheduleDraftFromBot(null)).toMatchObject({
      enabled: false,
      from: "22:00",
      to: "07:00",
      instanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
      effort: "high",
      contextWindow: "1m",
    });
  });

  it("reads a saved schedule back", () => {
    const saved: PersonalBotSchedule = {
      enabled: false,
      from: "09:30",
      to: "17:45",
      modelSelection: OPUS,
    };
    expect(scheduleDraftFromBot({ schedule: saved })).toMatchObject({
      enabled: false,
      from: "09:30",
      to: "17:45",
      model: "claude-opus-5-5",
      effort: "medium",
    });
  });

  it("only complains while the schedule is on, and says why in plain words", () => {
    expect(
      scheduleDraftProblem(draft({ enabled: false, from: "08:00", to: "08:00" }), OPUS, SONNET),
    ).toBeNull();
    expect(scheduleDraftProblem(draft(), OPUS, SONNET)).toBeNull();
    expect(scheduleDraftProblem(draft({ from: "08:00", to: "08:00" }), OPUS, SONNET)).toBe(
      "From and To can't be the same time.",
    );
    expect(scheduleDraftProblem(draft(), OPUS, null)).toBe("Pick a model for the scheduled time.");
    expect(scheduleDraftProblem(draft(), SONNET, sel("claude-sonnet-5-5", "high"))).toBe(
      "Pick a different model from the bot's own, or a different effort.",
    );
    expect(scheduleDraftProblem(draft(), sel("claude-sonnet-5-5", "low"), SONNET)).toBeNull();
  });

  it("sends nothing for no schedule that stays off, everything for a new one, the difference for a saved one", () => {
    const saved: PersonalBotSchedule = {
      enabled: true,
      from: "22:00",
      to: "07:00",
      modelSelection: SONNET,
    };
    expect(scheduleInput(null, draft({ enabled: false }), SONNET)).toBeUndefined();
    expect(scheduleInput(null, draft(), SONNET)).toEqual({
      enabled: true,
      from: "22:00",
      to: "07:00",
      modelSelection: SONNET,
    });
    expect(scheduleInput(saved, draft(), SONNET)).toBeUndefined();
    expect(scheduleInput(saved, draft({ to: "06:30" }), SONNET)).toEqual({ to: "06:30" });
    expect(scheduleInput(saved, draft({ enabled: false }), SONNET)).toEqual({ enabled: false });
    expect(scheduleInput(saved, draft(), OPUS)).toEqual({ modelSelection: OPUS });
    // Off after being on: the times and model are not resent.
    expect(scheduleInput(saved, draft({ enabled: false, to: "05:00" }), OPUS)).toEqual({
      enabled: false,
    });
  });

  it("words the result in one line", () => {
    expect(scheduleHelpLine({ from: "22:00", to: "07:00" }, "Sonnet 5.5 high")).toBe(
      "Every day 22:00 to 07:00 this bot uses Sonnet 5.5 high",
    );
  });
});
