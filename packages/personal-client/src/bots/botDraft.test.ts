import {
  type PersonalBot,
  PersonalBotId,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  assessBotDraft,
  botDraftsEqual,
  botNameProblem,
  deleteBotConfirmMessage,
  draftFromBot,
  firstSelectableProvider,
  newBotDraft,
  planBotSave,
  providerOptionsFor,
  selectableProviders,
  withStartingProvider,
} from "./botDraft.ts";

const botId = PersonalBotId.make("bot-1");

const model = (slug: string, isDefault = false): ServerProviderModel =>
  ({
    slug,
    name: slug,
    isCustom: false,
    isDefault,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  }) as ServerProviderModel;

const provider = (
  driver: string,
  models: ReadonlyArray<ServerProviderModel>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider =>
  ({
    instanceId: driver,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    availability: "available",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-17T00:00:00.000Z",
    models,
    ...overrides,
  }) as unknown as ServerProvider;

const claude = provider("claudeAgent", [model("claude-sonnet-5-5", true)]);
const codex = provider("codex", [model("gpt-6", true)]);

const savedBot = {
  botId,
  name: "Researcher",
  title: "Analyst",
  description: "Reads things",
  instructions: "Be brief",
  avatarShape: "blob",
  avatarColor: "#1A73E8",
  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
  enabled: true,
  sortOrder: 0,
  team: "assistant",
  lead: false,
  pinned: true,
  memoryAutoSave: false,
  hidePreviews: true,
} as unknown as PersonalBot;

describe("new bot draft", () => {
  it("starts on Claude Code when ready, with the provider's default model", () => {
    const draft = newBotDraft(selectableProviders([codex, claude]));
    expect(draft.instanceId).toBe("claudeAgent");
    expect(draft.model).toBe("claude-sonnet-5-5");
    expect(draft.name).toBe("");
    expect(draft.memoryAutoSave).toBe(true);
    expect(draft.pinned).toBe(false);
    expect(draft.notifications).toBe("on");
    expect(draft.avatarShape).toBe("blob");
    expect(draft.fallbackEnabled).toBe(true);
    expect(draft.scheduleEnabled).toBe(false);
    expect(draft.scheduleFrom).toBe("22:00");
    expect(draft.scheduleTo).toBe("07:00");
  });

  it("falls to the first ready provider when Claude Code is not", () => {
    expect(firstSelectableProvider(selectableProviders([codex]))?.instanceId).toBe("codex");
    expect(firstSelectableProvider([])).toBeUndefined();
  });

  it("takes a provider that arrives after the form opened, only for a new bot", () => {
    const cold = newBotDraft([]);
    expect(cold.instanceId).toBe("");
    const arrived = withStartingProvider(cold, true, [claude]);
    expect(arrived.instanceId).toBe("claudeAgent");
    expect(arrived.model).toBe("claude-sonnet-5-5");
    expect(withStartingProvider(cold, false, [claude])).toBe(cold);
    expect(withStartingProvider(arrived, true, [codex])).toBe(arrived);
  });
});

describe("draft from a saved bot", () => {
  it("carries every field the form shows", () => {
    const draft = draftFromBot(savedBot, 1_000);
    expect(draft).toMatchObject({
      name: "Researcher",
      title: "Analyst",
      description: "Reads things",
      instructions: "Be brief",
      instanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
      team: "assistant",
      lead: false,
      pinned: true,
      memoryAutoSave: false,
      hidePreviews: true,
      notifications: "on",
    });
  });

  it("reads a bot that is muted as keeping the mute", () => {
    const muted = {
      ...savedBot,
      notificationsMutedUntil: new Date(5_000_000).toISOString(),
    } as unknown as PersonalBot;
    expect(draftFromBot(muted, 1_000).notifications).toBe("keep");
  });

  it("compares field by field", () => {
    const draft = draftFromBot(savedBot, 1_000);
    expect(botDraftsEqual(draft, { ...draft })).toBe(true);
    expect(botDraftsEqual(draft, { ...draft, pinned: false })).toBe(false);
  });
});

describe("provider options", () => {
  it("keeps the bot's own provider listed when it went unavailable", () => {
    const gone = provider("codex", [], { enabled: false });
    const providers = [claude, gone];
    const selectable = selectableProviders(providers);
    expect(selectable.map((entry) => entry.instanceId)).toEqual(["claudeAgent"]);
    expect(providerOptionsFor("codex", providers, selectable).map((e) => e.instanceId)).toEqual([
      "codex",
      "claudeAgent",
    ]);
    expect(providerOptionsFor("claudeAgent", providers, selectable)).toHaveLength(1);
    expect(providerOptionsFor("missing", providers, selectable)).toHaveLength(1);
  });
});

describe("name validation", () => {
  const others = [
    { botId: PersonalBotId.make("bot-2"), name: "Analyst" },
    { botId, name: "Researcher" },
  ];

  it("asks for a name", () => {
    expect(botNameProblem("   ", botId, others)).toBe("Give your bot a name.");
  });

  it("refuses another bot's name in any case, but not the bot's own", () => {
    expect(botNameProblem("analyst", botId, others)).toBe("You already have a bot called Analyst.");
    expect(botNameProblem("researcher", botId, others)).toBeNull();
    expect(botNameProblem("Fresh", botId, others)).toBeNull();
  });
});

describe("assessing a draft", () => {
  it("cannot save without a provider and model, or while busy", () => {
    const empty = newBotDraft([]);
    expect(assessBotDraft(empty, [], null, false).canSave).toBe(false);
    const ready = newBotDraft([claude]);
    expect(assessBotDraft(ready, [claude], null, false).canSave).toBe(true);
    expect(assessBotDraft(ready, [claude], null, true).canSave).toBe(false);
  });

  it("blocks a schedule that is on with the same from and to", () => {
    const ready = { ...newBotDraft([claude]), scheduleEnabled: true, scheduleTo: "22:00" };
    const assessment = assessBotDraft(ready, [claude], null, false);
    expect(assessment.scheduleProblem).toBe("From and To can't be the same time.");
    expect(assessment.canSave).toBe(false);
  });

  it("blocks a fallback that is on with no model", () => {
    const ready = { ...newBotDraft([claude]), fallbackInstanceId: "", fallbackModel: "" };
    expect(assessBotDraft(ready, [claude], null, false).canSave).toBe(false);
    expect(
      assessBotDraft({ ...ready, fallbackEnabled: false }, [claude], null, false).canSave,
    ).toBe(true);
  });
});

describe("save plan", () => {
  const providers = [claude];
  const plan = (
    draft: ReturnType<typeof newBotDraft>,
    saved: PersonalBot | null,
    baseline = draft.notifications,
  ) =>
    planBotSave({
      botId,
      saved,
      draft,
      baselineNotifications: baseline,
      providers,
      assessment: assessBotDraft(draft, providers, saved, false),
    });

  it("creates with trimmed fields, the whole fallback and no follow-up", () => {
    const draft = {
      ...newBotDraft(providers),
      name: " Scout ",
      title: " Finder ",
      description: " finds ",
      instructions: " go ",
    };
    const result = plan(draft, null);
    if (result.kind !== "create") throw new Error("expected a create");
    expect(result.create).toMatchObject({
      botId,
      name: "Scout",
      title: "Finder",
      description: "finds",
      instructions: "go",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      team: "assistant",
      lead: false,
      pinned: false,
      memoryAutoSave: true,
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
    });
    expect(result.create.fallback?.enabled).toBe(true);
    expect(result.create.schedule).toBeUndefined();
    expect(result.followUp).toBeNull();
  });

  it("sends the mute and the privacy switch of a new bot as a follow-up update", () => {
    const draft = {
      ...newBotDraft(providers),
      name: "Scout",
      hidePreviews: true,
      notifications: "indefinitely" as const,
    };
    const result = plan(draft, null, "on");
    if (result.kind !== "create") throw new Error("expected a create");
    expect(result.followUp).toEqual({
      botId,
      notificationsMute: "indefinitely",
      hidePreviews: true,
    });
    expect(result.create).not.toHaveProperty("hidePreviews");
    expect(result.create).not.toHaveProperty("notificationsMute");
  });

  it("updates with the privacy switch, and a mute only when the choice changed", () => {
    const draft = draftFromBot(savedBot, 1_000);
    const untouched = plan(draft, savedBot);
    if (untouched.kind !== "update") throw new Error("expected an update");
    expect(untouched.update).toMatchObject({ botId, name: "Researcher", hidePreviews: true });
    expect(untouched.update).not.toHaveProperty("notificationsMute");
    expect(untouched.update).not.toHaveProperty("schedule");

    const muted = plan({ ...draft, notifications: "indefinitely" }, savedBot, "on");
    if (muted.kind !== "update") throw new Error("expected an update");
    expect(muted.update.notificationsMute).toBe("indefinitely");
  });
});

describe("delete confirm", () => {
  it("names the bot and says what goes with it", () => {
    expect(deleteBotConfirmMessage("Scout")).toBe(
      "Delete Scout completely?\nIts chats, routines and memories are removed too. This can't be undone.",
    );
  });
});
