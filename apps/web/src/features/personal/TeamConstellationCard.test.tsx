import type { ReactTestInstance } from "react-test-renderer";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { TeamConstellationCard, type ConstellationBot } from "./TeamConstellationCard";
import type { TeamCaption } from "./teamCaption";

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
  caption: { text: "Sonnet 5.5 · H", tone: "idle" } satisfies TeamCaption,
  needsYou: false,
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
const render = async (members: ReadonlyArray<ConstellationBot>, lead?: ConstellationBot) => {
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
        lead={lead ?? entry("cfo", "CFO", { caption: { text: "Working", tone: "working" } })}
        members={members}
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
/** Every piece of visible text on the card, joined per element. */
const texts = (tree: ReactTestRenderer): string[] =>
  tree.root
    .findAll(
      (node) =>
        (node.type === "span" || node.type === "button" || node.type === "p") &&
        (node.children ?? []).some(
          (child) => typeof child === "string" || typeof child === "number",
        ),
    )
    .map((node) =>
      (node.children ?? [])
        .flatMap((child: unknown) =>
          typeof child === "string" || typeof child === "number" ? [String(child)] : [],
        )
        .join("")
        .trim(),
    );

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
  it("crowns the lead and keeps 'team lead' in its accessible name", async () => {
    const tree = await render([]);
    const lead = named(tree, "CFO, team lead, Working");
    expect(lead).toBeDefined();
    // The crown is drawn with the name, not announced twice.
    expect(
      tree.root.findAll((node) => node.props["aria-hidden"] === "true").length,
    ).toBeGreaterThan(0);
  });

  it("keeps a long name whole: it wraps under the avatar, never cut to a fixed length", async () => {
    const tree = await render([entry("s", "Release Notes Copywriter")]);
    expect(named(tree, "Release Notes Copywriter, Sonnet 5.5 · H")).toBeDefined();
    const clamped = tree.root.findAll(
      (candidate) =>
        typeof candidate.props.className === "string" &&
        candidate.props.className.includes("line-clamp-2"),
    );
    expect(clamped.at(0)?.children).toEqual(["Release Notes Copywriter"]);
  });

  it("draws every member of a 15-bot team, none of them behind a seat", async () => {
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
    const more = named(tree, "9 more bots on Finance. See all.");
    expect(more).toBeDefined();
    await act(async () => more!.props.onClick());
    expect(opened).toEqual(["Finance"]);
    // Fifteen members and the lead are drawn; the last seat is the +N plate.
    expect(botNodes(tree)).toHaveLength(16);
  });

  it("opens the full list from the count, with the whole team size in its name", async () => {
    const tree = await render(many(3));
    const count = named(tree, "See all 4 bots on Finance, or move them");
    expect(count).toBeDefined();
    expect(texts(tree)).toContain("4 bots · Move");
    await act(async () => count!.props.onClick());
    expect(opened).toEqual(["Finance"]);
  });

  it("says how many are working and how many need the owner, in the header", async () => {
    const tree = await render(
      [
        entry("a", "Auditor", {
          live: true,
          caption: { text: "Running the tests", tone: "working" },
        }),
        entry("b", "Relay", {
          caption: { text: "Needs approval", tone: "needs" },
          needsYou: true,
        }),
        entry("c", "Quill"),
      ],
      entry("cfo", "CFO", {
        live: true,
        caption: { text: "Planning release 2.4", tone: "working" },
      }),
    );
    const labels = texts(tree);
    expect(labels).toContain("2 working");
    expect(labels).toContain("1 needs you");
  });

  it("shows the model when a bot is idle and the state word when it is not", async () => {
    const tree = await render([
      entry("a", "Quill"),
      entry("b", "Relay", {
        caption: { text: "Needs your reply", tone: "needs" },
        needsYou: true,
      }),
      entry("c", "Probe", { live: true, caption: { text: "Thinking", tone: "thinking" } }),
    ]);
    const labels = texts(tree);
    expect(labels).toContain("Sonnet 5.5 · H");
    expect(labels).toContain("Needs your reply");
    expect(labels).toContain("Thinking");
    // A bot waiting on the owner wears the amber ring.
    const ringed = tree.root.findAll(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.includes("ring-[var(--personal-state-needs"),
    );
    expect(ringed.length).toBeGreaterThan(0);
  });

  it("announces a working node with who it works for", async () => {
    const tree = await render([
      entry("d", "Designer", {
        workingFor: "CTO",
        live: true,
        caption: { text: "Laying out the Team card", tone: "working" },
      }),
    ]);
    expect(named(tree, "Designer, Laying out the Team card, working for CTO")).toBeDefined();
  });
});
