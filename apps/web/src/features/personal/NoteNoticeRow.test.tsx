import type { EnvironmentId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { NoteNoticeRow } from "./NoteNoticeRow";

const calls = vi.hoisted(() => ({
  undoNote: [] as unknown[],
  restore: [] as unknown[],
  result: { _tag: "Success", value: {} } as { readonly _tag: string; readonly cause?: unknown },
}));

vi.mock("./usePersonalAutomation", () => ({
  personalMemoryUndoNote: { name: "undoNote" },
  personalMemoryRestore: { name: "restore" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { name: "undoNote" | "restore" }) => async (input: unknown) => {
    calls[command.name].push(input);
    return calls.result;
  },
}));

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  calls.undoNote = [];
  calls.restore = [];
});

const render = (undo: "archive" | "restore") => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(
      <NoteNoticeRow
        environmentId={"env-1" as EnvironmentId}
        label="Saved a note: Likes tea."
        memoryId="m-1"
        undo={undo}
      />,
    );
  });
  return renderer!.root;
};

const undoButton = (root: ReactTestRenderer["root"]) =>
  root.findAll((node) => node.type === "button")[0];

describe("NoteNoticeRow", () => {
  it("Undo on a saved note archives it, then says Undone", async () => {
    const root = render("archive");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Saved a note: Likes tea.");
    await act(async () => undoButton(root)!.props.onClick());
    expect(calls.undoNote).toEqual([{ environmentId: "env-1", input: { memoryId: "m-1" } }]);
    expect(calls.restore).toEqual([]);
    expect(undoButton(root)).toBeUndefined();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Undone");
  });

  it("Undo on a forgotten note restores it", async () => {
    const root = render("restore");
    await act(async () => undoButton(root)!.props.onClick());
    expect(calls.restore).toEqual([{ environmentId: "env-1", input: { memoryId: "m-1" } }]);
    expect(calls.undoNote).toEqual([]);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Restored");
  });
});
