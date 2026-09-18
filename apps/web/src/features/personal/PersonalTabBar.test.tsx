import type { ReactNode } from "react";

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PersonalTabBar } from "./PersonalTabBar";

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
});
