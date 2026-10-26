import type { ReactNode } from "react";

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PersonalTabBar } from "./PersonalTabBar";

const ask = vi.hoisted(() => ({ open: false }));
vi.mock("./computer/useComputerAsk", () => ({ useComputerAsk: () => ask.open }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
}));

interface RenderedNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: ReadonlyArray<RenderedNode | string> | null;
}

const flatten = (node: RenderedNode | string | null): ReadonlyArray<RenderedNode> => {
  if (node === null || typeof node === "string") return [];
  return [node, ...(node.children ?? []).flatMap(flatten)];
};

const renderBar = (active: Parameters<typeof PersonalTabBar>[0]["active"]) => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(<PersonalTabBar active={active} />);
  });
  return flatten(renderer!.toJSON() as unknown as RenderedNode);
};

describe("PersonalTabBar", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", {});
  });

  afterEach(() => {
    ask.open = false;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("routes all four tabs, Computer among them, in four equal columns", () => {
    const nodes = renderBar("chats");
    const links = nodes.filter((node) => node.type === "a");
    expect(links.map((link) => link.props.to)).toEqual(["/bots", "/tasks", "/computer", "/files"]);
    expect(JSON.stringify(nodes.map((node) => node.props.className))).toContain("grid-cols-4");
    // The label is what the user reads on the bar; the icon is aria-hidden.
    expect(JSON.stringify(links[2])).toContain("Computer");
    // A tab-bar tap is an origin-less visit: /computer must not inherit a
    // `fromBot` from an earlier trip in through a chat's link.
    expect(links.map((link) => link.props.search)).toEqual([{}, {}, {}, {}]);
  });

  it("marks only the Computer tab as the current page on /computer", () => {
    const links = renderBar("computer").filter((node) => node.type === "a");
    expect(links.map((link) => link.props["aria-current"])).toEqual([
      undefined,
      undefined,
      "page",
      undefined,
    ]);
  });

  it("dots only the Computer tab while a bot is waiting on the owner there", () => {
    expect(
      renderBar("chats").filter((n) => n.props["data-testid"] === "computer-ask-dot"),
    ).toHaveLength(0);
    ask.open = true;
    const nodes = renderBar("chats");
    const links = nodes.filter((node) => node.type === "a");
    expect(JSON.stringify(links[2])).toContain("computer-ask-dot");
    expect(JSON.stringify(links[2])).toContain("a bot needs you");
    expect(JSON.stringify([links[0], links[1], links[3]])).not.toContain("computer-ask-dot");
  });
});
