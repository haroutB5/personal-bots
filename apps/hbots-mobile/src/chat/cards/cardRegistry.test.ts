import type { ConversationItem } from "@hbots/personal-client/conversation/conversationModel";
import { describe, expect, it } from "vite-plus/test";

import { CARD_KINDS, isChatCard } from "./cardKinds";

const item = (kind: string): ConversationItem => ({ kind, id: kind }) as never;

describe("isChatCard", () => {
  it("claims exactly the card kinds in the registry", () => {
    expect(CARD_KINDS).toEqual([
      "delegation",
      "question",
      "secret",
      "login",
      "connection-approval",
      "lead-bot-change",
      "memory-change",
    ]);
    for (const kind of CARD_KINDS) expect(isChatCard(item(kind))).toBe(true);
  });

  it("leaves messages, dividers and work rows to the transcript", () => {
    expect(isChatCard(item("divider"))).toBe(false);
    expect(isChatCard(item("message"))).toBe(false);
    expect(isChatCard(item("work"))).toBe(false);
    expect(isChatCard(item("plan"))).toBe(false);
    expect(isChatCard(item("call"))).toBe(false);
  });
});
