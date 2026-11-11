import { describe, expect, it } from "vite-plus/test";

import { CTO_ALIAS, ctoTileLink, findCtoBot, newChatLink, resolveNewChatTarget } from "./ctoTarget";
import { parseDeepLink } from "../nav/routes";

const bot = (
  botId: string,
  name: string,
  fields: { team?: string; lead?: boolean; enabled?: boolean } = {},
) => ({ botId, name, ...fields });

const lead = bot("b-lead", "Chief", { team: "dev", lead: true });
const named = bot("b-named", "CTO");
const other = bot("b-other", "Research", { team: "assistant" });

describe("the CTO link builder", () => {
  it("builds the new-chat link for a bot id", () => {
    expect(newChatLink("b-lead")).toBe("hbots://bot/b-lead?new=1");
  });

  it("uses the alias when no id is given", () => {
    expect(newChatLink()).toBe("hbots://bot/cto?new=1");
    expect(newChatLink()).toBe(`hbots://bot/${CTO_ALIAS}?new=1`);
  });

  it("escapes an id so the link stays one path segment", () => {
    expect(newChatLink("a/b c")).toBe("hbots://bot/a%2Fb%20c?new=1");
  });

  it("opens a new chat for the bot in the app", () => {
    for (const id of ["b-lead", CTO_ALIAS, "a/b c"]) {
      expect(parseDeepLink(newChatLink(id))?.stack.at(-1)).toEqual({
        kind: "botNewChat",
        botId: id,
      });
    }
  });

  it("keeps the plain bot link as the bot page", () => {
    expect(parseDeepLink("hbots://bot/b-lead")?.stack.at(-1)).toEqual({
      kind: "bot",
      botId: "b-lead",
    });
  });
});

describe("finding the CTO bot", () => {
  it("prefers the lead of the Dev team", () => {
    expect(findCtoBot([other, named, lead])).toBe(lead);
  });

  it("falls back to a bot named CTO", () => {
    expect(findCtoBot([other, named])).toBe(named);
  });

  it("ignores a disabled bot", () => {
    expect(findCtoBot([{ ...lead, enabled: false }, other])).toBeNull();
  });

  it("is null without a CTO bot", () => {
    expect(findCtoBot([other])).toBeNull();
    expect(findCtoBot([])).toBeNull();
  });
});

describe("the no-CTO-bot case", () => {
  it("publishes no link, so the tile keeps the alias", () => {
    expect(ctoTileLink([other])).toBeNull();
  });

  it("publishes the CTO link when one exists", () => {
    expect(ctoTileLink([other, lead])).toBe("hbots://bot/b-lead?new=1");
  });

  it("tells the alias screen there is no CTO", () => {
    expect(resolveNewChatTarget(CTO_ALIAS, [other])).toEqual({ kind: "no-cto" });
  });

  it("resolves the alias to the CTO bot", () => {
    expect(resolveNewChatTarget(CTO_ALIAS, [other, lead])).toEqual({
      kind: "bot",
      botId: "b-lead",
    });
  });

  it("refuses an id the user no longer has", () => {
    expect(resolveNewChatTarget("gone", [lead])).toEqual({ kind: "missing" });
    expect(resolveNewChatTarget("b-lead", [{ ...lead, enabled: false }])).toEqual({
      kind: "missing",
    });
  });

  it("opens a known bot id directly", () => {
    expect(resolveNewChatTarget("b-other", [other])).toEqual({ kind: "bot", botId: "b-other" });
  });
});
