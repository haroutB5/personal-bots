import type { ReactTestRenderer } from "react-test-renderer";
import { useEffect } from "react";
import { act, create } from "react-test-renderer";
import { PersonalBotId, ThreadId, type PersonalBrowserStatus } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ConversationComputerPanel } from "./ConversationComputerPanel";

const { paneMounts, paneUnmounts, useComputerFeed } = vi.hoisted(() => ({
  paneMounts: vi.fn(),
  paneUnmounts: vi.fn(),
  useComputerFeed: vi.fn(),
}));

vi.mock("./computer/computerState", () => ({ useComputerFeed }));
vi.mock("./computer/ComputerScreen", () => ({
  ComputerBrowserPane: ({ fullScreen }: { fullScreen?: boolean }) => {
    useEffect(() => {
      paneMounts();
      return paneUnmounts;
    }, []);
    return <div data-full-screen={fullScreen}>Live browser pane</div>;
  },
}));

const status = (threadId = "thread-a"): PersonalBrowserStatus => ({
  state: "connected",
  detail: null,
  lockedByPid: null,
  controller: {
    _tag: "Agent",
    threadId: ThreadId.make(threadId),
    botId: PersonalBotId.make("bot-1"),
    botName: "Developer",
  },
  generation: 1,
  page: { title: "T3 Code", url: "https://t3.codes" },
  viewers: 0,
});

describe("ConversationComputerPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal("window", {
      addEventListener: vi.fn((type: string, listener: EventListener) =>
        listeners.set(type, listener),
      ),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
      dispatchEvent: (event: Event) => listeners.get(event.type)?.(event),
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      body: { style: { overflow: "" } },
    });
    useComputerFeed.mockReturnValue({
      feed: { status: status(), events: [] },
      error: null,
      loading: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("appears collapsed for the exact chat holding the browser lease", () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ConversationComputerPanel
          environmentId={null}
          botId="bot-1"
          threadId="thread-a"
          manuallyVisible={false}
          expanded={false}
          onExpandedChange={() => undefined}
        />,
      );
    });
    expect(renderer!.root.findByProps({ "aria-expanded": false })).toBeDefined();
    expect(
      renderer!.root.findAll((node) => node.children.includes("Live browser pane")),
    ).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.children.includes("T3 Code"))).not.toHaveLength(0);
  });

  it("stays hidden for another chat unless manually revealed", () => {
    useComputerFeed.mockReturnValue({
      feed: { status: status("thread-other"), events: [] },
      error: null,
      loading: false,
    });
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ConversationComputerPanel
          environmentId={null}
          botId="bot-1"
          threadId="thread-a"
          manuallyVisible={false}
          expanded={false}
          onExpandedChange={() => undefined}
        />,
      );
    });
    expect(renderer!.toJSON()).toBeNull();
  });

  it("renders the standalone browser pane and collapses on request", () => {
    const onExpandedChange = vi.fn();
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ConversationComputerPanel
          environmentId={null}
          botId="bot-1"
          threadId="thread-other"
          manuallyVisible
          expanded
          onExpandedChange={onExpandedChange}
        />,
      );
    });
    expect(
      renderer!.root.findAll((node) => node.children.includes("Live browser pane")),
    ).not.toHaveLength(0);
    act(() => renderer!.root.findByProps({ "aria-expanded": true }).props.onClick());
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it("moves the same browser pane full screen and restores it on exit", () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ConversationComputerPanel
          environmentId={null}
          botId="bot-1"
          threadId="thread-other"
          manuallyVisible
          expanded
          onExpandedChange={() => undefined}
        />,
      );
    });
    expect(renderer!.root.findByProps({ "aria-label": "Full screen" })).toBeDefined();
    expect(paneMounts).toHaveBeenCalledTimes(1);

    act(() => renderer!.root.findByProps({ "aria-label": "Full screen" }).props.onClick());

    expect(renderer!.root.findByProps({ role: "dialog" }).props["aria-label"]).toBe(
      "Computer full screen",
    );
    expect(renderer!.root.findAllByProps({ "data-full-screen": true })).toHaveLength(1);
    // No collapse control full screen: collapsing would take the exit button
    // with it and strand the user on an empty overlay.
    expect(renderer!.root.findAllByProps({ "aria-expanded": true })).toHaveLength(0);
    expect(paneMounts).toHaveBeenCalledTimes(1);
    expect(paneUnmounts).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("hidden");

    act(() => renderer!.root.findByProps({ "aria-label": "Exit full screen" }).props.onClick());

    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "data-full-screen": false })).toHaveLength(1);
    expect(paneMounts).toHaveBeenCalledTimes(1);
    expect(paneUnmounts).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("");
  });

  it("exits full screen on Escape", () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ConversationComputerPanel
          environmentId={null}
          botId="bot-1"
          threadId="thread-other"
          manuallyVisible
          expanded
          onExpandedChange={() => undefined}
        />,
      );
    });
    act(() => renderer!.root.findByProps({ "aria-label": "Full screen" }).props.onClick());
    act(() => {
      window.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    });
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });
});
