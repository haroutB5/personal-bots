import type {
  PersonalBot,
  SelectProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  currentMuteLabelOf,
  descriptorChoices,
  descriptorValue,
  modelChoices,
  notificationChoices,
  scheduleTimeChoices,
  voiceCallsLine,
} from "./botFormFields.ts";

const effort: SelectProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ],
};

const modelOf = (slug: string, name: string): ServerProviderModel =>
  ({ slug, name, isCustom: false }) as unknown as ServerProviderModel;

describe("descriptorValue", () => {
  it("keeps an offered option and drops one the model does not offer", () => {
    expect(descriptorValue(effort, "low")).toBe("low");
    expect(descriptorValue(effort, "max")).toBe("");
    expect(descriptorValue(null, "low")).toBe("");
  });
});

describe("descriptorChoices", () => {
  it("names the model's default in the first row", () => {
    expect(descriptorChoices(effort)).toEqual([
      { value: "", label: "Default (High)" },
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
    ]);
  });

  it("reads plain Default when no option is the default", () => {
    const plain: SelectProviderOptionDescriptor = {
      ...effort,
      options: [{ id: "low", label: "Low" }],
    };
    expect(descriptorChoices(plain)[0]).toEqual({ value: "", label: "Default" });
  });
});

describe("modelChoices", () => {
  const models = [modelOf("a", "Alpha"), modelOf("b", "Beta")];

  it("lists the provider's models", () => {
    expect(modelChoices(models, "b")).toEqual([
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ]);
  });

  it("keeps a saved slug the provider no longer lists on top", () => {
    expect(modelChoices(models, "gone")[0]).toEqual({ value: "gone", label: "gone" });
  });
});

describe("scheduleTimeChoices", () => {
  it("offers 96 quarter hours", () => {
    const choices = scheduleTimeChoices("22:00");
    expect(choices).toHaveLength(96);
    expect(choices[0]).toBe("00:00");
    expect(choices[95]).toBe("23:45");
  });

  it("keeps a saved time that is off the grid, in order", () => {
    const choices = scheduleTimeChoices("07:10");
    expect(choices).toHaveLength(97);
    expect(choices.indexOf("07:10")).toBe(choices.indexOf("07:00") + 1);
  });
});

describe("notifications", () => {
  const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
  const mutedBot = (untilMs: number) =>
    ({ notificationsMutedUntil: new Date(untilMs).toISOString() }) as unknown as PersonalBot;

  it("offers On and the three mutes for a bot that is on", () => {
    expect(currentMuteLabelOf(mutedBot(NOW - 1), NOW)).toBeNull();
    expect(notificationChoices(null)).toEqual([
      { value: "on", label: "On" },
      { value: "1h", label: "Mute for 1 hour" },
      { value: "8h", label: "Mute for 8 hours" },
      { value: "indefinitely", label: "Off" },
    ]);
  });

  it("reads a bot muted until turned back on as Off and lists it once", () => {
    const label = currentMuteLabelOf(mutedBot(Date.UTC(9999, 0, 1)), NOW);
    expect(label).toBe("Off");
    expect(notificationChoices(label)).toEqual([
      { value: "keep", label: "Off" },
      { value: "on", label: "On" },
      { value: "1h", label: "Mute for 1 hour" },
      { value: "8h", label: "Mute for 8 hours" },
    ]);
  });

  it("names a timed mute by its end", () => {
    const label = currentMuteLabelOf(mutedBot(NOW + 3_600_000), NOW);
    expect(label?.startsWith("Muted until ")).toBe(true);
    expect(notificationChoices(label)[0]?.value).toBe("keep");
    expect(notificationChoices(label)).toHaveLength(5);
  });

  it("has no mute label for a new bot", () => {
    expect(currentMuteLabelOf(null, NOW)).toBeNull();
  });
});

describe("voiceCallsLine", () => {
  it("says calls are on for a lead and off otherwise", () => {
    expect(voiceCallsLine(true)).toBe(
      "On for team leads: this bot is one, so its chats show a call button.",
    );
    expect(voiceCallsLine(false)).toBe(
      "Off: only team leads can take calls. Make this bot a team lead to turn calls on.",
    );
  });
});
