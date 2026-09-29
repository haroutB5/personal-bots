import type { ReactTestInstance } from "react-test-renderer";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { TeamWorkingNow } from "./TeamWorkingNow";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: Record<string, unknown> & { children?: never }) => (
    <a {...rest} data-to={to as string} data-params={JSON.stringify(params)}>
      {children}
    </a>
  ),
}));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => null }));

const bot = (id: string, name: string): never =>
  ({ botId: id, name, title: "", avatarShape: "blob", avatarColor: "#1A73E8" }) as never;
const BOTS = new Map([
  ["cto", bot("cto", "CTO")],
  ["designer", bot("designer", "Designer")],
  ["backend", bot("backend", "Backend")],
]) as ReadonlyMap<string, never>;

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const render = async (items: Parameters<typeof TeamWorkingNow>[0]["items"]) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<TeamWorkingNow items={items} botsById={BOTS} nowMs={10_000_000} />);
  });
  return renderer!;
};

const links = (tree: ReactTestRenderer): ReactTestInstance[] => tree.root.findAllByType("a");

describe("TeamWorkingNow", () => {
  it("shows nothing while nothing is running", async () => {
    const tree = await render([]);
    expect(tree.toJSON()).toBeNull();
  });

  it("opens the receiving bot's task chat when a row is tapped", async () => {
    const tree = await render([
      {
        taskId: "t-1",
        from: "cto",
        to: "designer",
        title: "hbots: redesign the Team screen",
        threadId: "thread-d",
        sinceMs: 10_000_000 - 60 * 60_000,
      },
      {
        taskId: "t-2",
        from: "cto",
        to: "backend",
        title: "hbots 1.55",
        threadId: "thread-b",
        sinceMs: 10_000_000 - 69 * 60_000,
      },
    ]);
    const rows = links(tree);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.props["data-to"]).toBe("/bots/$botId/$threadId");
    expect(JSON.parse(rows[0]!.props["data-params"])).toEqual({
      botId: "designer",
      threadId: "thread-d",
    });
    expect(JSON.parse(rows[1]!.props["data-params"])).toEqual({
      botId: "backend",
      threadId: "thread-b",
    });
    expect(rows[0]!.props["aria-label"]).toBe(
      "CTO to Designer: hbots: redesign the Team screen. Open Designer's chat for this task.",
    );
  });

  it("opens the task page while the handoff has no chat yet", async () => {
    const tree = await render([
      { taskId: "t-9", from: "cto", to: "backend", title: "Queued", threadId: null, sinceMs: 0 },
    ]);
    const [row] = links(tree);
    expect(row!.props["data-to"]).toBe("/tasks/$taskId");
    expect(JSON.parse(row!.props["data-params"])).toEqual({ taskId: "t-9" });
  });
});
