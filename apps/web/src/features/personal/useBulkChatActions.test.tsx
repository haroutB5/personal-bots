import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useBulkChatActions } from "./useBulkChatActions";

const COMMANDS = vi.hoisted(() => ({
  archive: { name: "archive" },
  remove: { name: "remove" },
  update: { name: "update" },
}));
const state = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; input: unknown }>,
  result: { _tag: "Success", value: { done: [] as string[], failed: [] as unknown[] } } as unknown,
  cleared: [] as string[],
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { name: string }) => async (args: { input: unknown }) => {
    state.calls.push({ command: command.name, input: args.input });
    return state.result;
  },
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: async () => true }));
vi.mock("./usePersonalBots", () => ({
  personalBotArchiveThreads: COMMANDS.archive,
  personalBotDeleteThreads: COMMANDS.remove,
  personalBotUpdateThreads: COMMANDS.update,
}));
vi.mock("./chatsSnapshot", () => ({ dropChatFromSnapshot: () => {} }));
vi.mock("./unreadChats", () => ({ clearChatSeen: (id: string) => state.cleared.push(id) }));

let run: ReturnType<typeof useBulkChatActions>;
let renderer: ReactTestRenderer | undefined;

function Probe() {
  run = useBulkChatActions("env-1" as never);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.calls = [];
  state.cleared = [];
  state.result = { _tag: "Success", value: { done: ["a", "b"], failed: [] } };
  await act(async () => {
    renderer = create(<Probe />);
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("pin and unpin send pinned true or false for the chats, through updateThreads", async () => {
  const outcome = await run("pin", ["a", "b"], 0);
  expect(state.calls).toEqual([
    { command: "update", input: { threadIds: ["a", "b"], pinned: true } },
  ]);
  expect(outcome).toMatchObject({ status: "settled", notice: "Pinned 2 chats.", anyFailed: false });
  await run("unpin", ["a"], 0);
  expect(state.calls[1]).toEqual({ command: "update", input: { threadIds: ["a"], pinned: false } });
});

it("snooze sends the chosen time as a date, wake sends null", async () => {
  await run("snooze", ["a"], 0, { snoozeUntilMs: 1_800_000_000_000 });
  const input = state.calls[0]!.input as { threadIds: string[]; snoozedUntil: DateTime.Utc };
  expect(input.threadIds).toEqual(["a"]);
  expect(DateTime.toEpochMillis(input.snoozedUntil)).toBe(1_800_000_000_000);
  await run("wake", ["a"], 0);
  expect(state.calls[1]!.input).toEqual({ threadIds: ["a"], snoozedUntil: null });
});

it("mark unread asks the server, then drops what this device saw of each chat it marked", async () => {
  const outcome = await run("markUnread", ["a", "b"], 0);
  expect(state.calls).toEqual([
    { command: "update", input: { threadIds: ["a", "b"], markUnread: true } },
  ]);
  expect(state.cleared).toEqual(["a", "b"]);
  expect(outcome).toMatchObject({ notice: "2 chats marked unread." });
});

it("a chat the server refused is reported and is not cleared on this device", async () => {
  state.result = {
    _tag: "Success",
    value: { done: ["a"], failed: [{ threadId: "b", message: "That chat is archived." }] },
  };
  const outcome = await run("markUnread", ["a", "b"], 0);
  expect(state.cleared).toEqual(["a"]);
  expect(outcome).toMatchObject({
    status: "settled",
    failedIds: ["b"],
    anyFailed: true,
    notice: "1 chat marked unread. 1 chat couldn't be marked unread: That chat is archived.",
  });
});

it("a request that fails outright says so and leaves every chat selected", async () => {
  state.result = { _tag: "Failure", cause: Cause.fail({}) };
  const outcome = await run("snooze", ["a", "b"], 0, { snoozeUntilMs: 1 });
  expect(outcome).toMatchObject({
    status: "settled",
    failedIds: ["a", "b"],
    anyFailed: true,
    notice: "Couldn't snooze these chats. Try again.",
  });
  expect(state.cleared).toEqual([]);
});

it("archive and delete still go through their own commands", async () => {
  state.result = { _tag: "Success", value: { done: ["a"], failed: [] } };
  await run("archive", ["a"], 0);
  await run("delete", ["a"], 0);
  expect(state.calls.map((call) => call.command)).toEqual(["archive", "remove"]);
});

it("does nothing for an empty selection", async () => {
  expect(await run("pin", [], 0)).toEqual({ status: "cancelled" });
  expect(state.calls).toEqual([]);
});
