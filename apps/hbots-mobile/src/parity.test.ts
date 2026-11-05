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

const MERGED = ["A1", "A2", "A3", "A4", "A5", "A17"];

describe("Android parity ratchet", () => {
  it("keeps every merged PR registered", () => {
    for (const pr of MERGED) expect(MERGED_PRS).toContain(pr);
    expect(new Set(MERGED_PRS).size).toBe(MERGED_PRS.length);
  });

  it("keeps every A1 and A2 item claimed", () => {
    for (const item of A1_A2_ITEMS) expect(DONE_ITEMS).toContain(item);
  });
});
