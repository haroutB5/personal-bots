import { PersonalBotId, type PersonalBot, type PersonalBotTeam } from "@t3tools/contracts";
import { newBotDraft } from "@hbots/personal-client/bots/botDraft";
import { describe, expect, it } from "vite-plus/test";

import {
  botFormScreenState,
  botFormTitle,
  botSubmitDecision,
  botTeamChoices,
  type BotFormTarget,
} from "./botFormScreenModel";

const botOf = (id: string, name: string, team?: string): PersonalBot =>
  ({
    botId: PersonalBotId.make(id),
    name,
    ...(team === undefined ? {} : { team }),
  }) as unknown as PersonalBot;

const ada = botOf("bot-ada", "Ada");
const bea = botOf("bot-bea", "Bea", "research");
const edit: BotFormTarget = { kind: "edit", botId: "bot-ada" };

describe("botFormScreenState", () => {
  it("is always ready for a new bot, even before the list loads", () => {
    expect(botFormScreenState({ kind: "new" }, { bots: null, error: null })).toEqual({
      kind: "ready",
      bot: null,
    });
  });

  it("is loading until the list or an error arrives", () => {
    expect(botFormScreenState(edit, { bots: null, error: null })).toEqual({ kind: "loading" });
  });

  it("is an error when the list failed and nothing is cached", () => {
    expect(botFormScreenState(edit, { bots: null, error: "Can't reach your laptop." })).toEqual({
      kind: "error",
      message: "Can't reach your laptop.",
    });
  });

  it("is ready with the bot once it is in the list", () => {
    expect(botFormScreenState(edit, { bots: [bea, ada], error: null })).toEqual({
      kind: "ready",
      bot: ada,
    });
  });

  it("is not found when the list loaded without the bot", () => {
    expect(botFormScreenState(edit, { bots: [bea], error: null })).toEqual({ kind: "notFound" });
  });

  it("keeps a cached bot on screen when a refresh fails", () => {
    expect(botFormScreenState(edit, { bots: [ada], error: "offline" })).toEqual({
      kind: "ready",
      bot: ada,
    });
  });
});

describe("botFormTitle", () => {
  it("names the screen as the web does", () => {
    expect(botFormTitle({ kind: "ready", bot: null }, { kind: "new" })).toBe("New bot");
    expect(botFormTitle({ kind: "ready", bot: ada }, edit)).toBe("Edit Ada");
    expect(botFormTitle({ kind: "loading" }, edit)).toBe("Edit bot");
    expect(botFormTitle({ kind: "notFound" }, edit)).toBe("Edit bot");
  });
});

describe("botTeamChoices", () => {
  it("lists the built-in teams first, then custom and bot teams once each", () => {
    const custom: PersonalBotTeam[] = ["ops"];
    expect(botTeamChoices(custom, [ada, bea], ada)).toEqual([
      "dev",
      "assistant",
      "ops",
      "research",
    ]);
  });

  it("includes the edited bot's own team", () => {
    expect(botTeamChoices([], [], bea)).toEqual(["dev", "assistant", "research"]);
  });
});

describe("botSubmitDecision", () => {
  const draft = newBotDraft([]);
  const bots = [ada, bea];
  const fresh = PersonalBotId.make("bot-new");

  it("asks for a name first", () => {
    expect(botSubmitDecision({ draft, botId: fresh, bots, canSave: true })).toEqual({
      kind: "nameProblem",
      message: "Give your bot a name.",
    });
  });

  it("refuses a name another bot already has", () => {
    expect(
      botSubmitDecision({ draft: { ...draft, name: " ada " }, botId: fresh, bots, canSave: true }),
    ).toEqual({ kind: "nameProblem", message: "You already have a bot called Ada." });
  });

  it("lets a bot keep its own name", () => {
    expect(
      botSubmitDecision({
        draft: { ...draft, name: "Ada" },
        botId: PersonalBotId.make("bot-ada"),
        bots,
        canSave: true,
      }),
    ).toEqual({ kind: "save" });
  });

  it("blocks a named draft that cannot be saved yet", () => {
    expect(
      botSubmitDecision({
        draft: { ...draft, name: "Cleo" },
        botId: fresh,
        bots,
        canSave: false,
      }),
    ).toEqual({ kind: "blocked" });
  });
});
