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
  ComputerBrowserPane: ({
    fullScreen,
    onOpenFullScreen,
    onBackToChat,
  }: {
    fullScreen?: boolean;
    onOpenFullScreen?: () => void;
    onBackToChat?: () => void;
  }) => {
    useEffect(() => {
      paneMounts();
      return paneUnmounts;
    }, []);
    return (
      <div data-full-screen={fullScreen}>
        Live browser pane
        {fullScreen ? (
          <button type="button" aria-label="Back to chat" onClick={onBackToChat} />
        ) : (
          <button type="button" aria-label="Open browser full screen" onClick={onOpenFullScreen} />
        )}
      </div>
    );
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

  it("retires the bar when the browser transitions to offline", () => {
    const onBrowserClosed = vi.fn();
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
          manuallyVisible
          expanded={false}
          onExpandedChange={() => undefined}
          onBrowserClosed={onBrowserClosed}
        />,
      );
    });
    expect(onBrowserClosed).not.toHaveBeenCalled();
    useComputerFeed.mockReturnValue({
      feed: {
        status: { ...status("thread-other"), state: "offline", controller: { _tag: "None" } },
        events: [],
      },
      error: null,
      loading: false,
    });
    act(() => {
      renderer!.update(
        <ConversationComputerPanel
          environmentId={null}
          botId="bot-1"
          threadId="thread-a"
          manuallyVisible
          expanded={false}
          onExpandedChange={() => undefined}
          onBrowserClosed={onBrowserClosed}
        />,
      );
    });
    expect(onBrowserClosed).toHaveBeenCalledTimes(1);
  });

  it("does not retire a bar opened while the browser is already offline", () => {
    const onBrowserClosed = vi.fn();
    useComputerFeed.mockReturnValue({
      feed: {
        status: { ...status("thread-other"), state: "offline", controller: { _tag: "None" } },
        events: [],
      },
      error: null,
      loading: false,
    });
    act(() => {
      create(
        <ConversationComputerPanel
          environmentId={null}
          botId="bot-1"
          threadId="thread-a"
          manuallyVisible
          expanded={false}
          onExpandedChange={() => undefined}
          onBrowserClosed={onBrowserClosed}
        />,
      );
    });
    expect(onBrowserClosed).not.toHaveBeenCalled();
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
          onBrowserClosed={() => undefined}
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
          onBrowserClosed={() => undefined}
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
          onBrowserClosed={() => undefined}
        />,
      );
    });
    expect(
      renderer!.root.findAll((node) => node.children.includes("Live browser pane")),
    ).not.toHaveLength(0);
    act(() => renderer!.root.findByProps({ "aria-expanded": true }).props.onClick());
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it("opens the same browser pane from the preview and restores it on back", () => {
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
          onBrowserClosed={() => undefined}
        />,
      );
    });
    expect(renderer!.root.findByProps({ "aria-label": "Open browser full screen" })).toBeDefined();
    expect(paneMounts).toHaveBeenCalledTimes(1);

    act(() =>
      renderer!.root.findByProps({ "aria-label": "Open browser full screen" }).props.onClick(),
    );

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

    act(() => renderer!.root.findByProps({ "aria-label": "Back to chat" }).props.onClick());

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
          onBrowserClosed={() => undefined}
        />,
      );
    });
    act(() =>
      renderer!.root.findByProps({ "aria-label": "Open browser full screen" }).props.onClick(),
    );
    act(() => {
      window.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    });
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  it("releases full screen when an external close hides the panel, and reopens collapsed", () => {
    const props = {
      environmentId: null,
      botId: "bot-1",
      threadId: "thread-a",
      manuallyVisible: true,
      expanded: true,
      onExpandedChange: () => undefined,
      onBrowserClosed: () => undefined,
    };
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<ConversationComputerPanel {...props} />);
    });
    act(() =>
      renderer!.root.findByProps({ "aria-label": "Open browser full screen" }).props.onClick(),
    );
    expect(document.body.style.overflow).toBe("hidden");
    useComputerFeed.mockReturnValue({
      feed: { status: { ...status(), state: "offline", controller: { _tag: "None" } }, events: [] },
      error: null,
      loading: false,
    });
    act(() =>
      renderer!.update(
        <ConversationComputerPanel {...props} manuallyVisible={false} expanded={false} />,
      ),
    );
    expect(renderer!.toJSON()).toBeNull();
    expect(document.body.style.overflow).toBe("");
    act(() => renderer!.update(<ConversationComputerPanel {...props} expanded={false} />));
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    act(() => renderer!.unmount());
  });
});
