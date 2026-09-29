import { PersonalBot, PersonalFile } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { FilesScreen } from "./FilesScreen";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);
const decodeFile = Schema.decodeUnknownSync(PersonalFile);
const state = vi.hoisted(() => ({
  outcome: { status: "done" } as
    | { readonly status: "done" }
    | { readonly status: "cancelled" }
    | { readonly status: "failed"; readonly message: string },
  deleteCalls: [] as Array<string>,
  bulkCalls: [] as Array<ReadonlyArray<string>>,
  bulkOutcome: null as null | {
    readonly status: "settled";
    readonly notice: string;
    readonly doneIds: ReadonlyArray<string>;
    readonly failedIds: ReadonlyArray<string>;
    readonly anyFailed: boolean;
  },
  files: [] as Array<unknown>,
}));

const bot = decodeBot({
  botId: "bot-files",
  name: "Assistant",
  title: "",
  description: "",
  instructions: "",
  avatarShape: "blob",
  avatarColor: "#1A73E8",
  modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
  enabled: true,
  sortOrder: 0,
  createdAt: "2026-09-14T09:00:00.000Z",
  updatedAt: "2026-09-14T09:00:00.000Z",
});
const file = decodeFile({
  fileId: "thread-files-00000000-0000-4000-8000-000000000001-txt",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  botId: bot.botId,
  threadId: "thread-files",
  createdAt: "2026-09-14T10:00:00.000Z",
  url: "/api/assets/file",
  previewUrl: null,
  expiresAt: 9_999_999_999_999,
});

const otherBot = decodeBot({
  ...Schema.encodeSync(PersonalBot)(bot),
  botId: "bot-other",
  name: "Astra",
});
const fileFor = (botId: string, index: number, name: string) =>
  decodeFile({
    ...Schema.encodeSync(PersonalFile)(file),
    fileId: `thread-${botId}-00000000-0000-4000-8000-00000000000${index}-txt`,
    name,
    botId,
    threadId: `thread-${botId}`,
  });
const astraOne = fileFor("bot-other", 2, "plan.txt");
const astraTwo = fileFor("bot-other", 3, "draft.txt");
state.files = [file];

vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: () => null,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button type="button" data-menu-item onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("./useBulkDelete", () => ({
  FILE_NOUN: { one: "file", many: "files" },
  useBulkDeleteFiles: () => async (ids: ReadonlyArray<string>) => {
    state.bulkCalls.push(ids);
    return (
      state.bulkOutcome ?? {
        status: "settled",
        notice: `Deleted ${ids.length} files.`,
        doneIds: ids,
        failedIds: [],
        anyFailed: false,
      }
    );
  },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/assets/assetUrls", () => ({
  resolveAssetUrl: (base: string, relative: string) => `${base}${relative}`,
}));
vi.mock("~/state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://t3.test" } }),
}));
vi.mock("./ChatsScreen", () => ({ useMinuteClock: () => Date.parse("2026-09-14T10:01:00Z") }));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => <span /> }));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({ data: { bots: [bot, otherBot] }, error: null, refresh: vi.fn() }),
  usePersonalFiles: () => ({ data: { files: state.files }, error: null, refresh: vi.fn() }),
}));
vi.mock("./useDeleteFile", () => ({
  useDeleteFile: () => async (selected: PersonalFile) => {
    state.deleteCalls.push(selected.fileId);
    return state.outcome;
  },
}));
vi.mock("./FilePreviewSheet", () => ({
  FilePreviewSheet: ({
    file: previewed,
    onDelete,
  }: {
    file: PersonalFile | null;
    onDelete: () => Promise<unknown>;
  }) =>
    previewed === null ? null : (
      <button type="button" aria-label="Delete from preview" onClick={() => void onDelete()} />
    ),
}));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.outcome = { status: "done" };
  state.deleteCalls.length = 0;
  state.bulkCalls.length = 0;
  state.bulkOutcome = null;
  state.files = [file];
});

async function renderScreen() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Unit tests run in Node: select mode listens for Escape and times its notice on window.
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    }),
  );
  await act(async () => {
    renderer = create(<FilesScreen />);
  });
}

describe("FilesScreen deletion", () => {
  it("wires each file row to the shared two-sided swipe action", async () => {
    await renderScreen();
    const swipe = renderer!.root.findByProps({ label: "Delete notes.txt" });

    await act(async () => {
      await swipe.props.onDelete();
    });

    expect(state.deleteCalls).toEqual([file.fileId]);
  });

  it("uses the same delete path from the preview sheet", async () => {
    await renderScreen();
    await act(async () => {
      renderer!.root.findByProps({ "aria-haspopup": "dialog" }).props.onClick();
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Delete from preview" }).props.onClick();
    });

    expect(state.deleteCalls).toEqual([file.fileId]);
  });

  it("surfaces a refused deletion in a role=alert message", async () => {
    state.outcome = { status: "failed", message: "Laptop unreachable" };
    await renderScreen();

    await act(async () => {
      await renderer!.root.findByProps({ label: "Delete notes.txt" }).props.onDelete();
    });

    const alert = renderer!.root.findByProps({ role: "alert" });
    expect(JSON.stringify(alert.props.children)).toContain("Laptop unreachable");
  });
});

describe("FilesScreen select mode", () => {
  const headerTitle = () => renderer!.root.findByType("h1").props.children;
  const checkbox = (name: string) =>
    renderer!.root
      .findAllByProps({ role: "checkbox" })
      .find((node) => node.findAll((child) => child.children.includes(name)).length > 0)!;
  const button = (text: string) =>
    renderer!.root.findAll((node) => node.type === "button" && node.props.children === text)[0]!;
  const click = async (node: { props: { onClick: () => unknown } }) => {
    await act(async () => {
      await node.props.onClick();
    });
  };

  async function enterSelectMode() {
    state.files = [file, astraOne, astraTwo];
    await renderScreen();
    await click(button("Select files"));
  }

  it("selects files, all of them, one bot's, and deletes the pick once", async () => {
    await enterSelectMode();
    expect(headerTitle()).toBe("Select files");
    // No swipe or opening a file while selecting.
    expect(renderer!.root.findAllByProps({ label: "Delete notes.txt" })).toHaveLength(0);

    await click(checkbox("plan.txt"));
    await click(checkbox("notes.txt"));
    expect(headerTitle()).toBe("2 selected");

    await click(button("Select all"));
    expect(headerTitle()).toBe("3 selected");
    expect(button("Deselect all")).toBeDefined();

    // Astra's heading deselects only Astra's files.
    await click(renderer!.root.findByProps({ "aria-label": "Deselect all Astra files" }));
    expect(headerTitle()).toBe("1 selected");
    await click(renderer!.root.findByProps({ "aria-label": "Select all Astra files" }));
    await click(checkbox("draft.txt"));
    expect(headerTitle()).toBe("2 selected");

    await click(button("Delete"));
    expect(state.bulkCalls).toEqual([[file.fileId, astraOne.fileId]]);
    // Done: back to the plain list with the result line.
    expect(headerTitle()).toBe("Files");
    expect(renderer!.root.findByProps({ role: "status" }).props.children).toBe("Deleted 2 files.");
  });

  it("keeps the failed files selected and says how many failed", async () => {
    state.bulkOutcome = {
      status: "settled",
      notice: "Deleted 2 files. 1 file couldn't be deleted: Couldn't delete this file.",
      doneIds: [file.fileId, astraOne.fileId],
      failedIds: [astraTwo.fileId],
      anyFailed: true,
    };
    await enterSelectMode();
    await click(button("Select all"));
    await click(button("Delete"));

    expect(renderer!.root.findByProps({ role: "alert" }).props.children).toContain(
      "1 file couldn't be deleted",
    );
    expect(headerTitle()).toBe("1 selected");
    expect(checkbox("draft.txt").props["aria-checked"]).toBe(true);
    expect(checkbox("plan.txt").props["aria-checked"]).toBe(false);
  });

  it("leaves select mode on Cancel and on Escape", async () => {
    await enterSelectMode();
    await click(button("Cancel"));
    expect(headerTitle()).toBe("Files");

    await click(button("Select files"));
    expect(headerTitle()).toBe("Select files");
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    });
    expect(headerTitle()).toBe("Files");
  });

  it("keeps Delete off until something is selected", async () => {
    await enterSelectMode();
    expect(button("Delete").props.disabled).toBe(true);
    await click(checkbox("plan.txt"));
    expect(button("Delete").props.disabled).toBe(false);
  });
});
