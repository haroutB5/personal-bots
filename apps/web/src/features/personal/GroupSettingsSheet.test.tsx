import { PersonalBot, PersonalGroup } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { GroupMembersPanel, type GroupMembersActions } from "./GroupSettingsSheet";

// Base UI's menu needs a DOM; here only its items matter.
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render: React.ReactElement;
  }) => <div data-trigger={JSON.stringify(render.props)}>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuSeparator: () => <hr />,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button type="button" data-menu-item="" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: async () => true }));

const decodeBot = Schema.decodeUnknownSync(PersonalBot);
const decodeGroup = Schema.decodeUnknownSync(PersonalGroup);
const encodeGroup = Schema.encodeSync(PersonalGroup);
const at = "2026-09-24T21:00:00.000Z";

const bot = (botId: string, name: string, extra: Record<string, unknown> = {}) =>
  decodeBot({
    botId,
    name,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "pill",
    avatarColor: "#E8711A",
    modelSelection: { instanceId: "someRuntime", model: "some-model" },
    enabled: true,
    sortOrder: 0,
    createdAt: at,
    updatedAt: at,
    ...extra,
  });

const lunas = decodeGroup({
  groupId: "lunas",
  name: "Lunas",
  description: "",
  threadId: "lunas-thread",
  maxBotTurns: 8,
  members: ["luna1", "luna2"].map((botId, index) => ({
    groupId: "lunas",
    botId,
    threadId: `relay-${botId}`,
    role: "member",
    sortOrder: index,
    deliveredSeq: 0,
    joinedAt: at,
    leftAt: null,
  })),
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
});

const bots = [
  bot("luna1", "Luna1", { title: "Analyst", groupOnly: true, groupIds: ["lunas"] }),
  bot("luna2", "Luna2", { groupOnly: true, groupIds: ["lunas"] }),
  bot("ada", "Ada", { groupIds: [] }),
];

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function actions(overrides: Partial<GroupMembersActions> = {}): GroupMembersActions {
  return {
    onEditBot: vi.fn(),
    onNewBot: vi.fn(),
    onMessagePrivately: vi.fn(async () => null),
    onAddMember: vi.fn(async () => null),
    onRemoveMember: vi.fn(async () => null),
    confirm: vi.fn(async () => true),
    ...overrides,
  };
}

async function mount(given: GroupMembersActions) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <GroupMembersPanel group={lunas} groups={[lunas]} bots={bots} actions={given} />,
    );
  });
}

type Json = ReturnType<ReactTestRenderer["toJSON"]>;
const flatten = (node: Json | string | Json[]): string => {
  if (node === null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((entry) => flatten(entry)).join("");
  return (node.children ?? []).map((entry) => flatten(entry as Json | string)).join("");
};
/** The panel's visible text, as one string. */
const text = () => flatten(renderer!.toJSON());
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map((child) => textOf(child)).join("");
const buttonWith = (label: string): ReactTestInstance =>
  renderer!.root.find((node) => node.type === "button" && textOf(node).includes(label));
const byLabel = (label: string): ReactTestInstance =>
  renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === label);
const menuItem = (index: number, label: string): ReactTestInstance =>
  renderer!.root.findAll(
    (node) =>
      node.type === "button" && node.props["data-menu-item"] === "" && node.children[0] === label,
  )[index]!;
const click = async (node: ReactTestInstance) => {
  await act(async () => {
    (node.props as { onClick: () => void }).onClick();
  });
};

describe("GroupMembersPanel", () => {
  it("lists each member with its name and title, and a tap edits it", async () => {
    const given = actions();
    await mount(given);
    expect(text()).toContain("Members · 2 of 6");
    expect(text()).toContain("Luna1");
    expect(text()).toContain("Analyst");
    expect(text()).toContain("Luna2");
    // Explains why they are not in the Bots list.
    expect(text()).toContain("only in groups stay out of your Bots list");
    await click(byLabel("Edit Luna1"));
    expect(given.onEditBot).toHaveBeenCalledWith("luna1");
  });

  it("messages a member privately from its menu", async () => {
    const given = actions();
    await mount(given);
    await click(menuItem(1, "Message privately"));
    expect(given.onMessagePrivately).toHaveBeenCalledWith("luna2");
  });

  it("asks before removing, says where the bot goes, and drops the row at once", async () => {
    const pending = deferred<string | null>();
    const given = actions({ onRemoveMember: vi.fn(() => pending.promise) });
    await mount(given);
    await click(menuItem(0, "Remove from group"));
    expect(given.confirm).toHaveBeenCalledWith(
      "Remove Luna1 from Lunas?\nIt isn't in any other group, so it moves back to your Bots list. Nothing is deleted.",
    );
    // Optimistic: gone before the server answers.
    expect(text()).not.toContain("Luna1");
    expect(text()).toContain("Members · 1 of 6");
    await act(async () => pending.resolve(null));
    expect(given.onRemoveMember).toHaveBeenCalledWith("luna1");
  });

  it("puts a removed row back and says why when the server refuses", async () => {
    const given = actions({ onRemoveMember: vi.fn(async () => "Couldn't remove that bot.") });
    await mount(given);
    await click(menuItem(0, "Remove from group"));
    expect(text()).toContain("Luna1");
    expect(text()).toContain("Couldn't remove that bot.");
  });

  it("does nothing when the removal is not confirmed", async () => {
    const given = actions({ confirm: vi.fn(async () => false) });
    await mount(given);
    await click(menuItem(0, "Remove from group"));
    expect(given.onRemoveMember).not.toHaveBeenCalled();
    expect(text()).toContain("Luna1");
  });

  it("adds an existing bot from the picker, showing it at once", async () => {
    const pending = deferred<string | null>();
    const given = actions({ onAddMember: vi.fn(() => pending.promise) });
    await mount(given);
    const add = buttonWith("Add member");
    await click(add);
    // The picker offers bots outside the group, and a new one.
    expect(text()).toContain("New bot");
    expect(text()).not.toContain("Luna2");
    await click(byLabel("Add Ada"));
    expect(given.onAddMember).toHaveBeenCalledWith("ada");
    expect(text()).toContain("Members · 3 of 6");
    expect(text()).toContain("Adding…");
    await act(async () => pending.resolve(null));
    // Still shown while the group catches up, never flickering out.
    expect(text()).toContain("Ada");
    const withAda = decodeGroup({
      ...encodeGroup(lunas),
      members: [
        ...encodeGroup(lunas).members,
        { ...encodeGroup(lunas).members[0]!, botId: "ada", threadId: "relay-ada", sortOrder: 2 },
      ],
    });
    await act(async () => {
      renderer!.update(
        <GroupMembersPanel group={withAda} groups={[withAda]} bots={bots} actions={given} />,
      );
    });
    expect(text()).toContain("Ada");
    expect(text()).not.toContain("Adding…");
    expect(text()).toContain("Members · 3 of 6");
  });

  it("creates a new bot straight into the group from the picker", async () => {
    const given = actions();
    await mount(given);
    const add = buttonWith("Add member");
    await click(add);
    const newBot = buttonWith("New bot");
    await click(newBot);
    expect(given.onNewBot).toHaveBeenCalled();
  });
});
