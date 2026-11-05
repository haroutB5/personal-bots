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

const A9_ITEMS = [
  "screen:routes/_personal.bots_.$botId.edit.tsx#bots-botid-edit",
  "screen:routes/_personal.bots_.$botId.index.tsx#bots-botid",
  "screen:routes/_personal.bots_.new.tsx#bots-new",
  "action:BotThreadsScreen.tsx#select-chats",
  "action:BotThreadsScreen.tsx#select-archived-chats",
  "action:BotThreadsScreen.tsx#long-press",
  "action:BotThreadsScreen.tsx#swipe-to-delete",
  "setting:BotAvatarPicker.tsx#shape",
  "setting:BotAvatarPicker.tsx#colour",
  "setting:BotFallbackSection.tsx#switch-model-when-the-usage-limit-is-hit-the-bot",
  "setting:BotForm.tsx#name",
  "setting:BotForm.tsx#title-optional",
  "setting:BotForm.tsx#description",
  "setting:BotForm.tsx#instructions",
  "setting:BotForm.tsx#provider",
  "setting:BotForm.tsx#model",
  "setting:BotForm.tsx#effort",
  "setting:BotForm.tsx#context-window",
  "setting:BotForm.tsx#agent-mode",
  "setting:BotForm.tsx#team",
  "setting:BotForm.tsx#team-lead-one-per-team-making-this-bot-the-lead-",
  "setting:BotForm.tsx#pin-to-top-keeps-this-bot-in-the-pinned-box-at-t",
  "setting:BotForm.tsx#save-memories-without-asking-keeps-what-you-tell",
  "setting:BotForm.tsx#hide-message-previews-keeps-this-bot-s-message-t",
  "setting:BotForm.tsx#notifications",
  "setting:BotForm.tsx#avatar",
  "setting:BotModelPickFields.tsx#provider",
  "setting:BotModelPickFields.tsx#model",
  "setting:BotModelPickFields.tsx#effort",
  "setting:BotModelPickFields.tsx#context-window",
  "setting:BotScheduleSection.tsx#use-a-different-model-at-set-times-every-day-bet",
  "setting:BotScheduleSection.tsx#from",
  "setting:BotScheduleSection.tsx#to",
  "rpc:personalBotsCreate",
  "rpc:personalBotsUpdate",
  "rpc:personalBotsRecheckProvider",
  "rpc:personalBotsDelete",
];

const A10_ITEMS = [
  "screen:routes/_personal.bots_.groups.$groupId.tsx#bots-groups-groupid",
  "screen:routes/_personal.bots_.groups.new.tsx#bots-groups-new",
  "sheet:GroupDeleteSheet.tsx#delete",
  "sheet:GroupSettingsSheet.tsx#groupsettingssheet",
  "action:GroupConversationScreen.tsx#group-settings",
  "action:GroupConversationScreen.tsx#stop",
  "action:GroupConversationScreen.tsx#unpin-group-pin-group",
  "action:GroupConversationScreen.tsx#snooze",
  "action:GroupConversationScreen.tsx#unarchive-group",
  "action:GroupConversationScreen.tsx#archive-group",
  "action:GroupConversationScreen.tsx#delete-group",
  "action:GroupSettingsSheet.tsx#message-privately",
  "action:GroupSettingsSheet.tsx#edit-bot",
  "action:GroupSettingsSheet.tsx#remove-from-group",
  "card:GroupRoundCard.tsx#grouproundcard",
  "card:GroupVoteCard.tsx#groupvotecard",
  "setting:GroupDeleteSheet.tsx#only-in-this-group",
  "setting:NewGroupScreen.tsx#name",
  "setting:NewGroupScreen.tsx#bots-of",
  "setting:NewGroupScreen.tsx#field-with-a-data-driven-label-in-newgroupscreen",
  "rpc:personalGroupsList",
  "rpc:personalGroupsSubscribe",
  "rpc:personalGroupsCreate",
  "rpc:personalGroupsUpdate",
  "rpc:personalGroupsDelete",
  "rpc:personalGroupsAddMember",
  "rpc:personalGroupsRemoveMember",
  "rpc:personalGroupsSendMessage",
  "rpc:personalGroupsContinueRound",
  "rpc:personalGroupsStop",
];

const A11_ITEMS = [
  "screen:routes/_personal.bots_.settings_.removed.tsx#bots-settings-removed",
  "screen:routes/_personal.bots_.team.tsx#bots-team",
  "screen:routes/_personal.bots_.teams.new.tsx#bots-teams-new",
  "sheet:TeamLeadConfirm.tsx#sheet-in-teamleadconfirm",
  "sheet:TeamMembersSheet.tsx#teammemberssheet",
  "sheet:TeamScreen.tsx#new-team-with",
  "action:TeamConstellationCard.tsx#remove-team-remove-team-move-its-bots-first",
  "action:TeamScreen.tsx#drag-a-bot-between-teams",
  "card:TeamConstellationCard.tsx#teamconstellationcard",
  "setting:NewTeamForm.tsx#team-name",
  "setting:NewTeamForm.tsx#leader-optional",
  "setting:NewTeamForm.tsx#no-leader-for-now",
  "setting:NewTeamForm.tsx#field-with-a-data-driven-label-in-newteamform",
  "setting:NewTeamForm.tsx#bots-to-move-into-the-new-team",
  "setting:NewTeamForm.tsx#field-with-a-data-driven-label-in-newteamform-2",
  "rpc:personalBotsListRemoved",
  "rpc:personalBotsRestore",
];

describe("Android parity ratchet", () => {
  it("keeps A1, A2 and the chat PRs merged", () => {
    expect(MERGED_PRS).toEqual(["A1", "A2", "A3", "A4", "A5", "A9", "A10", "A11"]);
  });

  it("keeps every A1 and A2 item claimed", () => {
    for (const item of A1_A2_ITEMS) expect(DONE_ITEMS).toContain(item);
  });

  it("claims every A9 item, including the bot editor fields and the thread list actions", () => {
    for (const item of A9_ITEMS) expect(DONE_ITEMS).toContain(item);
  });

  it("claims every A10 item, including the group sheets, cards and every group RPC", () => {
    for (const item of A10_ITEMS) expect(DONE_ITEMS).toContain(item);
  });

  it("claims every A11 item, including the team sheets, move action and removed-bot RPCs", () => {
    for (const item of A11_ITEMS) expect(DONE_ITEMS).toContain(item);
  });
});
