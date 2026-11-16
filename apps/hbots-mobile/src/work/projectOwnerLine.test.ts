import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const cards = NodeFS.readFileSync(new URL("./ProjectCards.tsx", import.meta.url), "utf8");
const sheet = NodeFS.readFileSync(new URL("./ProjectSheet.tsx", import.meta.url), "utf8");
const host = NodeFS.readFileSync(new URL("./GoalSheetHost.tsx", import.meta.url), "utf8");
const screen = NodeFS.readFileSync(new URL("./WorkScreen.tsx", import.meta.url), "utf8");

/** One component's source, from its `function Name(` or `export function Name(` to the next one. */
function component(source: string, name: string): string {
  const match = new RegExp(`(?:export )?function ${name}\\(`).exec(source);
  if (match === null) return "";
  const start = match.index;
  const next = source.slice(start + match[0].length).search(/\n(?:export )?function [A-Z]/);
  return next < 0 ? source.slice(start) : source.slice(start, start + match[0].length + next);
}

const owner = component(cards, "GoalOwnerLine");

describe("the goal owner line on a card", () => {
  it("sits directly under the goal title, before the step segments", () => {
    const card = component(cards, "Card");
    const title = card.indexOf("styles.name");
    const line = card.indexOf("<GoalOwnerLine");
    const segments = card.indexOf("<Segments");
    expect(title).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(title);
    expect(segments).toBeGreaterThan(line);
  });

  it("gets the open chats and the chat opener from the Work tab", () => {
    expect(cards).toContain("chats: ReadonlyMap<string, GoalChatLookup>");
    expect(component(cards, "ProjectCards")).toContain("onOpenChat");
    expect(screen).toContain("goalChatMap({ shells, links: links ?? [] })");
    expect(screen).toMatch(/<ProjectCards[\s\S]*?chats=\{goalChats\}/);
  });
});

describe("the goal owner line on the sheet", () => {
  it("is the first thing under the sheet title", () => {
    expect(sheet).toContain("goalChatLine({");
    expect(sheet.indexOf("<GoalOwnerLine")).toBeGreaterThan(-1);
    expect(sheet.indexOf("<GoalOwnerLine")).toBeLessThan(sheet.indexOf("Kept by"));
  });

  it("gets the same open chats from its host", () => {
    expect(host).toContain("goalChatMap({ shells, links: links ?? [] })");
    expect(host).toMatch(/<ProjectSheet[\s\S]*?chats=\{goalChats\}/);
  });
});

describe("the goal owner line itself", () => {
  it("opens the chat it names on a tap", () => {
    expect(owner).toContain("const threadId = line.threadId;");
    expect(owner).toContain("onOpenChat(line.botId, threadId)");
    expect(owner).toContain('accessibilityRole="button"');
  });

  it("is at least 48 dp high to tap", () => {
    expect(cards).toMatch(/owner: \{[^}]*minHeight: 48/);
  });

  it("ellipsizes only the chat title, never the bot name", () => {
    expect(owner).toMatch(/styles\.ownerChat[\s\S]*?numberOfLines=\{1\}/);
    const botName = owner.slice(owner.indexOf("styles.ownerBot"), owner.indexOf("styles.ownerSep"));
    expect(botName).not.toContain("numberOfLines");
  });
});
