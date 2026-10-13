import type { ReactNode } from "react";

import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { HomeRail, type RailBotItem } from "./HomeRail";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to: _to,
    params: _params,
    ...rest
  }: {
    children: ReactNode;
    to?: string;
    params?: unknown;
    [key: string]: unknown;
  }) => <a {...(rest as Record<string, unknown>)}>{children}</a>,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
}));

function bots(count: number): RailBotItem[] {
  return Array.from({ length: count }, (_, index) => ({
    botId: `bot-${index}`,
    name: `Bot ${index}`,
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    caption: { label: "Idle", tone: "idle" },
    motion: undefined,
    comet: false,
  })) as RailBotItem[];
}

function fakeScroller() {
  const attributes = new Map<string, string>([["data-edge", "start"]]);
  const element = {
    scrollLeft: 0,
    scrollWidth: 1000,
    clientWidth: 390,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: vi.fn((name: string, value: string) => {
      attributes.set(name, value);
    }),
  };
  return { element, attributes };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HomeRail scroll edge", () => {
  it("writes the edge to the scroller without rendering the tiles again", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", {
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
    });
    vi.stubGlobal("localStorage", { getItem: () => null });
    const scroller = fakeScroller();
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        <HomeRail
          chats={[]}
          groups={[]}
          bots={bots(10)}
          onUnpinChat={() => undefined}
          onUnpinGroup={() => undefined}
        />,
        { createNodeMock: (node) => (node.type === "ul" ? scroller.element : null) },
      );
    });
    const rail = renderer!.root.findByProps({ "data-testid": "home-rail" });
    const tilesBefore = renderer!.root.findAll((node) => node.type === "li").length;
    scroller.element.scrollLeft = 120;
    await act(async () => rail.props.onScroll());
    expect(scroller.attributes.get("data-edge")).toBe("middle");
    scroller.element.scrollLeft = 610;
    await act(async () => rail.props.onScroll());
    expect(scroller.attributes.get("data-edge")).toBe("end");
    scroller.element.scrollLeft = 0;
    await act(async () => rail.props.onScroll());
    expect(scroller.attributes.get("data-edge")).toBe("start");
    // React's own prop never moved off "start": no render was needed.
    expect(rail.props["data-edge"]).toBe("start");
    expect(renderer!.root.findAll((node) => node.type === "li").length).toBe(tilesBefore);
    await act(async () => renderer!.unmount());
  });
});
