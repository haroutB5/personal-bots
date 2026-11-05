import { describe, expect, it } from "vite-plus/test";

import { DONE_ITEMS, MERGED_PRS } from "./parity";

const A1_A2_ITEMS = [
  "screen:routes/_personal.tsx#personal",
  "action:PersonalShell.tsx#edge-swipe-back",
  "action:useChatSwipeBack.tsx#edge-swipe-back",
  "screen:routes/_personal.bots.tsx#bots",
  "sheet:PersonalResetCredits.tsx#redeem-a-banked-x-reset",
  "sheet:PersonalUsageStrip.tsx#sheet-in-personalusagestrip",
  "action:ChatsScreen.tsx#new-bot",
  "action:ChatsScreen.tsx#new-group",
  "action:ChatsScreen.tsx#new-team",
  "action:PersonalUsageStrip.tsx#drag-a-sheet-down-to-close",
  "card:PersonalOfflineBanner.tsx#personalofflinebanner",
  "card:PersonalUsageStrip.tsx#personalusagestrip",
  "rpc:personalPushAckInApp",
  "rpc:personalPushInApp",
  "rpc:personalBotsGetProfile",
  "rpc:personalBotsTokenUsage",
  "rpc:personalBotsWorkingProgress",
  "rpc:personalBotsThreadShells",
];

describe("Android parity ratchet", () => {
  it("keeps A1, A2 and the chat PRs merged", () => {
    expect(MERGED_PRS).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7"]);
  });

  it("keeps every A1 and A2 item claimed", () => {
    for (const item of A1_A2_ITEMS) expect(DONE_ITEMS).toContain(item);
  });

  it("keeps every A6 card claimed", () => {
    for (const item of [
      "card:DelegationCard.tsx#delegationcard",
      "card:LeadBotChangeCard.tsx#leadbotchangecard",
      "card:MemoryChangeCard.tsx#memorychangecard",
      "card:QuestionCard.tsx#questioncard",
      "card:RulesUsageCard.tsx#rulesusagecard",
      "card:WorkRecordCard.tsx#workrecordcard",
      "action:DelegationCard.tsx#open-chat",
      "setting:QuestionCard.tsx#or-type-your-own-answer",
      "rpc:personalLeadBotChangesList",
      "rpc:personalLeadBotChangesDecide",
    ]) {
      expect(DONE_ITEMS).toContain(item);
    }
  });
});
