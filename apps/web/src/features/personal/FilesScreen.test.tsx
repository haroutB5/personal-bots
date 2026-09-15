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
  usePersonalBotsList: () => ({ data: { bots: [bot] }, error: null, refresh: vi.fn() }),
  usePersonalFiles: () => ({ data: { files: [file] }, error: null, refresh: vi.fn() }),
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
});

async function renderScreen() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
