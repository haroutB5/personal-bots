import type { ReactTestRenderer } from "react-test-renderer";
import { act, create } from "react-test-renderer";
import { PersonalBotId, ThreadId, type PersonalBrowserStatus } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ConversationComputerPanel } from "./ConversationComputerPanel";

const { useComputerFeed } = vi.hoisted(() => ({ useComputerFeed: vi.fn() }));

vi.mock("./computer/computerState", () => ({ useComputerFeed }));
vi.mock("./computer/ComputerScreen", () => ({
  ComputerBrowserPane: () => <div>Live browser pane</div>,
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
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", { visibilityState: "visible" });
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
});
