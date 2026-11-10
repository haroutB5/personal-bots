import { describe, expect, it } from "vite-plus/test";

import { DONE_ITEMS, MERGED_PRS } from "./parity";

const A1_A2_ITEMS = [
  "screen:routes/_personal.tsx#personal",
  "screen:PersonalUnreachableScreen.tsx#personalunreachablescreen",
  "action:PersonalShell.tsx#edge-swipe-back",
  "action:useChatSwipeBack.tsx#edge-swipe-back",
  "screen:routes/_personal.bots.tsx#bots",
  "sheet:PersonalResetCredits.tsx#alertdialog-in-personalresetcredits",
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
  "rpc:personalBotsSubscribeThreadShells",
];

const A12_ITEMS = [
  "screen:routes/_personal.tasks.tsx#tasks",
  "screen:routes/_personal.tasks_.$taskId.tsx#tasks-taskid",
  "screen:routes/_personal.tasks_.routines_.$routineId.tsx#tasks-routines-routineid",
  "screen:routes/_personal.tasks_.routines_.$routineId_.edit.tsx#tasks-routines-routineid-edit",
  "screen:routes/_personal.tasks_.routines_.new.tsx#tasks-routines-new",
  "action:TasksScreen.tsx#select-routines",
  "action:TasksScreen.tsx#long-press",
  "setting:RoutineForm.tsx#name",
  "setting:RoutineForm.tsx#bot",
  "setting:RoutineForm.tsx#task-each-time-it-runs",
  "setting:RoutineForm.tsx#what-starts-it",
  "setting:RoutineForm.tsx#event-name",
  "setting:RoutineForm.tsx#when",
  "setting:RoutineForm.tsx#days",
  "setting:RoutineForm.tsx#every-how-many-hours",
  "setting:RoutineForm.tsx#date",
  "setting:RoutineForm.tsx#time",
  "setting:RoutineForm.tsx#time-zone",
  "setting:RoutineForm.tsx#if-the-laptop-was-asleep-at-run-time",
  "setting:RoutineForm.tsx#field-with-a-data-driven-label-in-routineform",
  "setting:RoutineForm.tsx#notify-me",
  "setting:RoutineForm.tsx#field-with-a-data-driven-label-in-routineform-2",
  "rpc:personalTasksSubscribe",
  "rpc:personalTasksGet",
  "rpc:personalTasksRelated",
  "rpc:personalTasksHistory",
  "rpc:personalRoutinesList",
  "rpc:personalTasksCancel",
  "rpc:personalTasksRetry",
  "rpc:personalRoutinesCreate",
  "rpc:personalRoutinesUpdate",
  "rpc:personalRoutinesDelete",
  "rpc:personalRoutinesPause",
  "rpc:personalRoutinesResume",
  "rpc:personalRoutinesDeleteMany",
  "rpc:personalRoutinesSetEnabledMany",
  "rpc:personalRoutinesRunNow",
  "rpc:personalRoutinesRegenerateHook",
];

const A13_ITEMS = [
  "screen:routes/_personal.files.tsx#files",
  "sheet:FilePreviewSheet.tsx#filepreviewsheet",
  "action:FilesScreen.tsx#select-files",
  "action:FilePreviewSheet.tsx#drag-a-sheet-down-to-close",
  "action:FilesScreen.tsx#long-press",
  "action:FilesScreen.tsx#swipe-to-delete",
  "rpc:personalBotsListFiles",
  "rpc:personalFilesDelete",
  "rpc:personalFilesDeleteMany",
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

const A14_ITEMS = [
  "screen:routes/_personal.bots_.settings.tsx#bots-settings",
  "screen:routes/_personal.bots_.settings_.notifications.tsx#bots-settings-notifications",
  "screen:routes/_personal.bots_.settings_.providers.$instanceId.tsx#bots-settings-providers-instanceid",
  "screen:routes/_personal.bots_.settings_.providers.add.tsx#bots-settings-providers-add",
  "screen:routes/_personal.bots_.settings_.providers.catalog.$catalogId.tsx#bots-settings-providers-catalog-catalogid",
  "sheet:providers/ProviderSheets.tsx#providersheet",
  "sheet:providers/ProviderSheets.tsx#confirmsheet",
  "sheet:providers/ProviderSheets.tsx#installconfirmsheet",
  "sheet:providers/ProviderSheets.tsx#remapsheet",
  "setting:PersonalSettingsScreen.tsx#your-name-section",
  "setting:PersonalSettingsScreen.tsx#your-name-displaynameform",
  "setting:PersonalSettingsScreen.tsx#bots-section",
  "setting:PersonalSettingsScreen.tsx#bots-team",
  "setting:PersonalSettingsScreen.tsx#bots-new-bot",
  "setting:PersonalSettingsScreen.tsx#bots-removed-bots",
  "setting:PersonalSettingsScreen.tsx#chat-section",
  "setting:PersonalSettingsScreen.tsx#chat-show-tool-steps",
  "setting:PersonalSettingsScreen.tsx#chat-show-routines-in-chats",
  "setting:PersonalSettingsScreen.tsx#chat-autoarchivetaskchatsrow",
  "setting:PersonalSettingsScreen.tsx#plugins-section",
  "setting:PersonalSettingsScreen.tsx#plugins-connections",
  "setting:PersonalSettingsScreen.tsx#plugins-passwords",
  "setting:PersonalSettingsScreen.tsx#plugins-api-keys",
  "setting:PersonalSettingsScreen.tsx#routines-memory-and-notifications-section",
  "setting:PersonalSettingsScreen.tsx#routines-memory-and-notifications-routines",
  "setting:PersonalSettingsScreen.tsx#routines-memory-and-notifications-memory",
  "setting:PersonalSettingsScreen.tsx#routines-memory-and-notifications-notifications",
  "setting:PersonalSettingsScreen.tsx#about-section",
  "setting:PersonalSettingsScreen.tsx#about-about",
  "setting:PersonalProvidersSection.tsx#providers-section",
  "setting:NotificationsScreen.tsx#field-with-a-data-driven-label-in-notificationss",
  "setting:providers/ProviderKeyEntry.tsx#field-with-a-data-driven-label-in-providerkeyent",
  "setting:providers/ProviderPage.tsx#server-address",
  "pref:profile#displayName",
  "pref:profile#teamChange",
  "pref:profile#autoArchiveTaskChats",
  "pref:profile#voiceCalls",
  "pref:profile#autoArchiveTaskChatsAfterMinutes",
  "pref:profile#usageVisibility",
  "pref:profile#showToolSteps",
  "pref:profile#showRoutinesStrip",
  "rpc:personalPushGetSettings",
  "rpc:personalPushTest",
  "rpc:personalPushSetPreferences",
  "rpc:personalBotsSetProfile",
];

const A15_ITEMS = [
  "screen:routes/_personal.bots_.settings_.api-keys.tsx#bots-settings-api-keys",
  "screen:routes/_personal.bots_.settings_.connections.tsx#bots-settings-connections",
  "screen:routes/_personal.bots_.settings_.memory.tsx#bots-settings-memory",
  "screen:routes/_personal.bots_.settings_.passwords.tsx#bots-settings-passwords",
  "action:MemoryScreen.tsx#select-memories",
  "action:PasswordsScreen.tsx#select-logins",
  "action:MemoryScreen.tsx#long-press",
  "action:PasswordsScreen.tsx#long-press",
  "setting:ApiKeysScreen.tsx#name",
  "setting:ApiKeysScreen.tsx#label-optional",
  "setting:ApiKeysScreen.tsx#value",
  "setting:MemoryScreen.tsx#search-memory",
  "setting:PasswordsScreen.tsx#label",
  "setting:PasswordsScreen.tsx#website-origin",
  "setting:PasswordsScreen.tsx#username",
  "setting:PasswordsScreen.tsx#password",
  "setting:PersonalConnectionsScreen.tsx#field-with-a-data-driven-label-in-personalconnec",
  "setting:PersonalConnectionsScreen.tsx#messages-a-day",
  "rpc:personalMemoryList",
  "rpc:personalMemoryRulesUsage",
  "rpc:personalMemoryTurnContext",
  "rpc:personalMemoryTidyLog",
  "rpc:personalMemoryCards",
  "rpc:personalMemoryDelete",
  "rpc:personalMemoryFeedback",
  "rpc:personalMemoryDeleteMany",
  "rpc:personalMemoryRestore",
  "rpc:personalMemoryGet",
  "rpc:personalMemoryUndoNote",
  "rpc:personalMemoryTidySetMode",
  "rpc:personalMemoryTidyRun",
  "rpc:personalMemoryTidyDecide",
  "rpc:personalMemoryTidyUndo",
  "rpc:personalConnectionsList",
  "rpc:personalConnectionsConnect",
  "rpc:personalConnectionsValidate",
  "rpc:personalConnectionsDisable",
  "rpc:personalConnectionsReconnect",
  "rpc:personalConnectionsDisconnect",
  "rpc:personalConnectionsRotate",
  "rpc:personalConnectionsBrowserConnect",
  "rpc:personalConnectionsSetSettings",
  "rpc:personalConnectionsImportProbe",
  "rpc:personalConnectionsImportAdopt",
  "rpc:personalLoginsList",
  "rpc:personalLoginsCreate",
  "rpc:personalLoginsUpdate",
  "rpc:personalLoginsDelete",
  "rpc:personalLoginsDeleteMany",
  "rpc:personalLoginsSetSensitive",
  "rpc:personalSecretsList",
  "rpc:personalSecretsCreate",
  "rpc:personalSecretsSetSharing",
  "rpc:personalSecretsSetMode",
  "rpc:personalSecretsDelete",
];

const A16_ITEMS = [
  "screen:routes/_personal.computer.tsx#computer",
  "sheet:computer/ComputerActivityCard.tsx#computeractivitysheet",
  "sheet:computer/ComputerSheet.tsx#computersheet",
  "action:computer/ComputerScreen.tsx#page-forward",
  "action:computer/ComputerScreen.tsx#reload",
  "action:computer/ComputerScreen.tsx#escape",
  "action:computer/ComputerScreen.tsx#reload-2",
  "action:computer/ComputerScreen.tsx#close-browser",
  "action:computer/ComputerSheet.tsx#drag-a-sheet-down-to-close",
  "card:computer/ComputerActivityCard.tsx#computeractivitycard",
  "card:computer/ComputerDriverCard.tsx#computerdrivercard",
  "card:computer/ComputerHelpCard.tsx#computerhelpcard",
  "rpc:personalBrowserActivity",
  "rpc:personalBrowserListFiles",
  "rpc:personalBrowserTakeControl",
  "rpc:personalBrowserReturnToAgent",
  "rpc:personalBrowserClose",
  "rpc:personalBrowserApproveEgress",
  "rpc:personalBrowserRefuseEgress",
  "rpc:personalDesktopStatus",
  "rpc:personalDesktopStop",
  "rpc:personalDesktopActivity",
];

describe("Android parity ratchet", () => {
  it("keeps A1, A2 and the chat PRs merged", () => {
    expect(MERGED_PRS).toEqual([
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "A6",
      "A7",
      "A8",
      "A9",
      "A10",
      "A11",
      "A12",
      "A13",
      "A14",
      "A15",
      "A16",
      "A17",
      "A18",
    ]);
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

  it("claims every A12 item, including the five task and routine screens", () => {
    for (const item of A12_ITEMS) expect(DONE_ITEMS).toContain(item);
  });

  it("claims every A13 item, including the Files sheet and its three actions", () => {
    for (const item of A13_ITEMS) expect(DONE_ITEMS).toContain(item);
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

  it("claims every A14 item, including the provider screens, sheets and settings RPCs", () => {
    for (const item of A14_ITEMS) expect(DONE_ITEMS).toContain(item);
  });

  it("claims every A15 item, including the four screens, selection actions and credential RPCs", () => {
    for (const item of A15_ITEMS) expect(DONE_ITEMS).toContain(item);
  });

  it("claims every A16 item, including the live view, its actions, cards and RPCs", () => {
    for (const item of A16_ITEMS) expect(DONE_ITEMS).toContain(item);
  });

  it("claims the A17 pairing screen", () => {
    expect(DONE_ITEMS).toContain("screen:routes/pair.tsx#pair");
  });

  it("claims the A18 device list and its two calls", () => {
    for (const item of [
      "screen:routes/_personal.bots_.settings_.devices.tsx#bots-settings-devices",
      "setting:PersonalSettingsScreen.tsx#plugins-devices",
      "rpc:personalDevicesList",
      "rpc:personalDevicesRevoke",
    ]) {
      expect(DONE_ITEMS).toContain(item);
    }
  });
});
