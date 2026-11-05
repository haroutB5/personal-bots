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

describe("Android parity ratchet", () => {
  it("keeps A1, A2 and the chat PRs merged", () => {
    expect(MERGED_PRS).toEqual(["A1", "A2", "A3", "A4", "A5", "A12"]);
  });

  it("keeps every A1 and A2 item claimed", () => {
    for (const item of A1_A2_ITEMS) expect(DONE_ITEMS).toContain(item);
  });

  it("claims every A12 item, including the five task and routine screens", () => {
    for (const item of A12_ITEMS) expect(DONE_ITEMS).toContain(item);
  });
});
