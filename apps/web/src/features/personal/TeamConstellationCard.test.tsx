import type { ReactTestInstance } from "react-test-renderer";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { TeamConstellationCard, type ConstellationBot } from "./TeamConstellationCard";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: Record<string, unknown> & { children?: never }) => (
    <a {...rest} data-to={to as string} data-params={JSON.stringify(params)}>
      {children}
    </a>
  ),
}));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => null }));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children?: never }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children?: never }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children?: never }) => <div>{children}</div>,
  MenuItem: ({ children, ...rest }: Record<string, unknown> & { children?: never }) => (
    <button {...rest}>{children}</button>
  ),
}));

const entry = (
  id: string,
  name: string,
  extra: Partial<ConstellationBot> = {},
): ConstellationBot => ({
  bot: {
    botId: id,
    name,
    title: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
  } as never,
  modelLabel: "Sonnet 5.5 · H",
  live: false,
  workingFor: null,
  ...extra,
});

const handlers = () =>
  ({
    onPointerDown: () => undefined,
    onPointerMove: () => undefined,
    onPointerUp: () => undefined,
    onPointerCancel: () => undefined,
    onClickCapture: () => undefined,
    onDragStart: () => undefined,
    onContextMenu: () => undefined,
  }) as never;

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const opened: string[] = [];
const render = async (
  members: ReadonlyArray<ConstellationBot>,
  spokes: ReadonlyMap<string, { recent: number; running: boolean }> = new Map(),
) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  opened.length = 0;
  await act(async () => {
    renderer = create(
      <TeamConstellationCard
        group={{
          team: "Finance",
          label: "Finance",
          leadBotId: "cfo",
          memberBotIds: members.map((member) => member.bot.botId),
        }}
        label="Finance"
        lead={entry("cfo", "CFO", { modelLabel: "Opus 5.5 · X" })}
        members={members}
        spokes={spokes}
        maxSpoke={4}
        custom={false}
        removable={false}
        removeBusy={false}
        draggingBotId={null}
        movingBotId={null}
        handlersFor={handlers}
        onOpenMembers={(team) => opened.push(team)}
        onRemove={() => undefined}
      />,
    );
  });
  return renderer!;
};

const named = (tree: ReactTestRenderer, label: string): ReactTestInstance | undefined =>
  tree.root.findAll((node) => node.props["aria-label"] === label).at(0);
const botNodes = (tree: ReactTestRenderer) =>
  tree.root.findAll((node) => node.type === "a" && node.props["data-bot-node"] !== undefined);

const NAMES = [
  "Quarterly budget planner",
  "Invoice reconciliation",
  "Expense categoriser",
  "Payroll scheduler",
  "Cashflow forecaster",
  "Tax compliance checker",
  "Vendor onboarding",
  "Receipts scanner",
  "Currency converter",
  "Audit trail keeper",
  "Subscription tracker",
  "Bank feed importer",
  "Ledger archivist",
  "Budget variance analyst",
  "CFO scheduler",
];
const many = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    entry(`m${String(index)}`, NAMES[index % NAMES.length]!),
  );

describe("TeamConstellationCard", () => {
  it("keeps a long name whole: it wraps under the avatar and is on the node's label", async () => {
    const tree = await render([entry("s", "CFO scheduler")]);
    const node = named(tree, "CFO scheduler, Sonnet 5.5 · H");
    expect(node).toBeDefined();
    expect(node!.props.title).toBe("CFO scheduler");
    // The visible label wraps to two lines; it is never cut to a fixed length.
    const text = tree.root.findAll(
      (candidate) =>
        typeof candidate.props.className === "string" &&
        candidate.props.className.includes("line-clamp-2"),
    );
    expect(text.at(0)?.children).toEqual(["CFO scheduler"]);
  });

  it("draws every member of a 15-bot team with names of 14 or more characters", async () => {
    const tree = await render(many(15));
    const nodes = botNodes(tree);
    // 15 members and the lead.
    expect(nodes).toHaveLength(16);
    expect(nodes.filter((node) => String(node.props.title).length >= 14).length).toBeGreaterThan(9);
    expect(
      tree.root.findAll((node) => String(node.props["aria-label"]).includes("more bots")),
    ).toHaveLength(0);
  });

  it("puts the overflow of a very full team behind a +N seat that opens the list", async () => {
    const tree = await render(many(24));
    const more = named(tree, "5 more bots on Finance. See all.");
    expect(more).toBeDefined();
    await act(async () => more!.props.onClick());
    expect(opened).toEqual(["Finance"]);
    // Nineteen members and the lead are drawn.
    expect(botNodes(tree)).toHaveLength(20);
  });

  it("opens the full list from the count, with the whole team size in its name", async () => {
    const tree = await render(many(3));
    const count = named(tree, "See all 4 bots on Finance");
    expect(count).toBeDefined();
    await act(async () => count!.props.onClick());
    expect(opened).toEqual(["Finance"]);
  });

  it("puts the week's handoff count on the node's name, and on the avatar when no spoke can be drawn", async () => {
    const tree = await render(
      many(20),
      new Map(many(20).map((m) => [m.bot.botId, { recent: 4, running: false }])),
    );
    const counted = tree.root.findAll((node) =>
      String(node.props["aria-label"]).endsWith("4 handoffs this week"),
    );
    expect(counted.length).toBeGreaterThan(15);
    // Crowded: the spokes that would cross another node are shown as a number instead.
    const badges = tree.root.findAll(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.includes("-top-1 -right-2"),
    );
    expect(badges.length).toBeGreaterThan(0);
  });

  it("labels a working node for the screen reader, with who it works for", async () => {
    const tree = await render([entry("d", "Designer", { workingFor: "CTO", live: true })]);
    expect(named(tree, "Designer, Sonnet 5.5 · H, working for CTO")).toBeDefined();
  });
});
