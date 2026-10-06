import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useGroupChatState } from "./useGroupChatState";

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  result: { _tag: "Success", value: {} } as unknown,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (args: unknown) => {
    state.calls.push(args);
    return state.result;
  },
}));
vi.mock("./usePersonalGroups", () => ({ personalGroupUpdate: {} }));

let actions: ReturnType<typeof useGroupChatState>;
let renderer: ReactTestRenderer | undefined;

function Probe({ environmentId }: { environmentId: string | null }) {
  actions = useGroupChatState(environmentId as never);
  return null;
}

const mount = async (environmentId: string | null) => {
  await act(async () => {
    renderer = create(<Probe environmentId={environmentId} />);
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.calls = [];
  state.result = { _tag: "Success", value: {} };
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("pins and unpins through the group update", async () => {
  await mount("env-1");
  expect(await actions.setPinned("g1", true)).toBeNull();
  expect(await actions.setPinned("g1", false)).toBeNull();
  expect(state.calls).toEqual([
    { environmentId: "env-1", input: { groupId: "g1", pinned: true } },
    { environmentId: "env-1", input: { groupId: "g1", pinned: false } },
  ]);
});

it("snoozes until a time, and wakes with null", async () => {
  await mount("env-1");
  await actions.snooze("g1", 1_800_000_000_000);
  await actions.snooze("g1", null);
  const first = (state.calls[0] as { input: { snoozedUntil: DateTime.Utc } }).input.snoozedUntil;
  expect(DateTime.toEpochMillis(first)).toBe(1_800_000_000_000);
  expect(state.calls[1]).toEqual({
    environmentId: "env-1",
    input: { groupId: "g1", snoozedUntil: null },
  });
});

it("answers with a message when the server refuses, and when there is no connection", async () => {
  state.result = { _tag: "Failure", cause: Cause.fail({ message: "Group not found." }) };
  await mount("env-1");
  expect(await actions.setPinned("g1", true)).toBe("Group not found.");
  state.result = { _tag: "Failure", cause: Cause.fail({}) };
  expect(await actions.snooze("g1", null)).toBe("Couldn't wake this group. Try again.");
  await act(async () => renderer?.unmount());
  await mount(null);
  expect(await actions.setPinned("g1", true)).toBe("Not connected to your computer.");
});
