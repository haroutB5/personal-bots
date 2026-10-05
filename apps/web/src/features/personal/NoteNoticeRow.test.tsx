import type { EnvironmentId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { NoteNoticeRow, noteUndoSettled } from "./NoteNoticeRow";

const calls = vi.hoisted(() => ({
  undoNote: [] as unknown[],
  restore: [] as unknown[],
  result: { _tag: "Success", value: {} } as { readonly _tag: string; readonly cause?: unknown },
  entry: null as null | {
    kind?: string;
    source?: string;
    supersededAt: unknown;
    supersededReason: string | null;
  },
}));

vi.mock("./usePersonalAutomation", () => ({
  personalMemoryUndoNote: { name: "undoNote" },
  personalMemoryRestore: { name: "restore" },
  usePersonalMemoryEntry: () => ({ data: calls.entry, error: null }),
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
  calls.entry = null;
});

const render = (
  undo: "archive" | "restore",
  readOnly = false,
  label = "Saved a note: Likes tea.",
) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  act(() => {
    renderer = create(
      <NoteNoticeRow
        environmentId={"env-1" as EnvironmentId}
        label={label}
        memoryId="m-1"
        undo={undo}
        readOnly={readOnly}
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
    expect(calls.undoNote).toEqual([
      { environmentId: "env-1", input: { memoryId: "m-1", undo: "archive" } },
    ]);
    expect(calls.restore).toEqual([]);
    expect(undoButton(root)).toBeUndefined();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Undone");
  });

  it("Security (1.60.22): Undo on a forgotten note uses the note-only Undo, never the generic restore", async () => {
    const root = render("restore");
    await act(async () => undoButton(root)!.props.onClick());
    expect(calls.undoNote).toEqual([
      { environmentId: "env-1", input: { memoryId: "m-1", undo: "restore" } },
    ]);
    expect(calls.restore).toEqual([]);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Restored");
  });
});

describe("Security (1.60.22): a used Undo stays done after a reload", () => {
  it("a note already undone shows Undone, with no button", () => {
    calls.entry = {
      kind: "note",
      supersededAt: "2026-10-02T08:00:00.000Z",
      supersededReason: "Undone from the chat.",
    };
    const root = render("archive");
    expect(undoButton(root)).toBeUndefined();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Undone");
  });

  it("a forgotten note already restored shows Restored", () => {
    calls.entry = { kind: "note", supersededAt: null, supersededReason: null };
    const root = render("restore");
    expect(undoButton(root)).toBeUndefined();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Restored");
  });

  it("settled wording from the entry as it is now", () => {
    expect(noteUndoSettled("archive", null)).toBeNull();
    expect(
      noteUndoSettled("archive", { kind: "note", supersededAt: null, supersededReason: null }),
    ).toBeNull();
    expect(
      noteUndoSettled("archive", {
        kind: "note",
        supersededAt: "x" as never,
        supersededReason: "Replaced by a newer save.",
      }),
    ).toBe("Archived");
    expect(
      noteUndoSettled("restore", {
        kind: "note",
        supersededAt: "x" as never,
        supersededReason: "Forgotten by a bot (a note it found out of date).",
      }),
    ).toBeNull();
  });
});

describe("QA (1.60.22): archived chats", () => {
  it("a read-only note line has no Undo and changes nothing", () => {
    const root = render("archive", true);
    expect(undoButton(root)).toBeUndefined();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Saved a note: Likes tea.");
    expect(calls.undoNote).toEqual([]);
  });
});

describe("Security (1.60.22): Undo only while the entry is still a note", () => {
  it("an entry made a preference since shows no Undo", () => {
    calls.entry = {
      kind: "preference",
      supersededAt: "2026-10-02T08:00:00.000Z",
      supersededReason: "Forgotten at the user's request.",
    };
    const root = render("restore");
    expect(undoButton(root)).toBeUndefined();
    expect(JSON.stringify(renderer!.toJSON())).toContain("No longer a note");
  });

  it("a forgotten note archived another way since shows Archived, no Undo", () => {
    expect(
      noteUndoSettled("restore", {
        kind: "note",
        supersededAt: "x" as never,
        supersededReason: "Replaced by a newer save.",
      }),
    ).toBe("Archived");
  });
});

describe("1.60.42: the lines for a rule", () => {
  const SAVED = "Saved a rule: Quote coin prices in USD.";
  const FORGOT = "Forgot a rule: Quote coin prices in USD.";
  const FORGOT_REASON = "Forgotten by a bot at the user's word.";

  it("a saved rule shows Undo (not 'No longer a note') and archives it", async () => {
    calls.entry = {
      kind: "preference",
      source: "bot:personal-seed-assistant;from=chat;rule",
      supersededAt: null,
      supersededReason: null,
    };
    const root = render("archive", false, SAVED);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("No longer");
    expect(undoButton(root)!.props["aria-label"]).toBe("Undo: archive this rule");
    await act(async () => undoButton(root)!.props.onClick());
    expect(calls.undoNote).toEqual([
      { environmentId: "env-1", input: { memoryId: "m-1", undo: "archive" } },
    ]);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Undone");
  });

  it("a forgotten rule shows Undo whatever its source, and restores it", async () => {
    for (const source of [
      "bot:personal-seed-assistant",
      "bot:cto;from=chat",
      "tidy-approved:run-7",
      "user",
    ]) {
      calls.undoNote = [];
      calls.entry = {
        kind: "preference",
        source,
        supersededAt: "2026-10-05T01:00:00.000Z",
        supersededReason: FORGOT_REASON,
      };
      const root = render("restore", false, FORGOT);
      expect(undoButton(root), source).toBeDefined();
      expect(undoButton(root)!.props["aria-label"]).toBe("Undo: restore this rule");
      await act(async () => undoButton(root)!.props.onClick());
      expect(calls.undoNote).toEqual([
        { environmentId: "env-1", input: { memoryId: "m-1", undo: "restore" } },
      ]);
      act(() => renderer?.unmount());
      renderer = null;
    }
  });

  it("after a reload the used Undo reads as done, and a rule archived another way as Archived", () => {
    expect(
      noteUndoSettled(
        "restore",
        { kind: "preference", source: "user", supersededAt: null, supersededReason: null },
        "rule",
      ),
    ).toBe("Restored");
    expect(
      noteUndoSettled(
        "archive",
        {
          kind: "preference",
          source: "bot:cfo;from=chat;rule",
          supersededAt: "x" as never,
          supersededReason: "Undone from the chat.",
        },
        "rule",
      ),
    ).toBe("Undone");
    expect(
      noteUndoSettled(
        "restore",
        {
          kind: "preference",
          source: "user",
          supersededAt: "x" as never,
          supersededReason: "Forgotten at the user's request.",
        },
        "rule",
      ),
    ).toBe("Archived");
  });

  it("a rule line is not an Undo for an entry that is not a saved rule", () => {
    // Saved another way (no rule source): the server would refuse, so no button.
    expect(
      noteUndoSettled(
        "archive",
        { kind: "preference", source: "user", supersededAt: null, supersededReason: null },
        "rule",
      ),
    ).toBe("No longer a saved rule");
    // Became a note since.
    expect(
      noteUndoSettled(
        "archive",
        {
          kind: "note",
          source: "bot:cfo;from=chat;rule",
          supersededAt: null,
          supersededReason: null,
        },
        "rule",
      ),
    ).toBe("No longer a rule");
    // And a note line still never reads a rule (the 1.60.22 protection).
    expect(
      noteUndoSettled(
        "archive",
        {
          kind: "preference",
          source: "bot:cfo;from=chat;rule",
          supersededAt: null,
          supersededReason: null,
        },
        "note",
      ),
    ).toBe("No longer a note");
  });

  it("a read-only rule line has no Undo", () => {
    calls.entry = {
      kind: "preference",
      source: "bot:cfo;from=chat;rule",
      supersededAt: null,
      supersededReason: null,
    };
    const root = render("archive", true, SAVED);
    expect(undoButton(root)).toBeUndefined();
    expect(JSON.stringify(renderer!.toJSON())).toContain(SAVED);
  });
});
