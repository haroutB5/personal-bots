import type { ReactNode } from "react";

import {
  EnvironmentId,
  PersonalBotId,
  ThreadId,
  type PersonalBrowserStatus,
} from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ComputerBrowserPane, ComputerScreen } from "./ComputerScreen";

const state = vi.hoisted(() => ({
  takeControl: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  returnToAgent: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  close: vi.fn(async () => ({ _tag: "Success", value: undefined })),
}));

const commands = vi.hoisted(() => ({
  takeControl: { label: "takeControl" },
  returnToAgent: { label: "returnToAgent" },
  close: { label: "close" },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === commands.takeControl) return state.takeControl;
    if (command === commands.returnToAgent) return state.returnToAgent;
    return state.close;
  },
}));
const feedState = vi.hoisted(() => ({
  status: null as PersonalBrowserStatus | null,
}));

vi.mock("./computerState", () => ({
  computerEnvironment: commands,
  fileDownloadUrl: () => "",
  refreshComputerAccess: () => undefined,
  useComputerAccess: () => null,
  useComputerFeed: () => ({
    feed: { status: feedState.status, events: [] },
    error: null,
    loading: false,
  }),
  viewportStreamUrl: () => "",
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: vi.fn(async () => true) }));
vi.mock("~/state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, refresh: vi.fn() }),
}));
vi.mock("../usePersonalBots", () => ({
  usePersonalEnvironmentId: () => EnvironmentId.make("env-1"),
}));
vi.mock("./viewportClient", () => ({ connectViewport: vi.fn() }));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  MenuPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

const STATUS: PersonalBrowserStatus = {
  state: "connected",
  detail: null,
  lockedByPid: null,
  controller: {
    _tag: "Agent",
    threadId: ThreadId.make("thread-a"),
    botId: PersonalBotId.make("bot-1"),
    botName: "Developer",
  },
  generation: 1,
  page: { title: "T3 Code", url: "https://t3.codes" },
  helpRequest: null,
  lastAgent: null,
  viewers: 0,
};

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  feedState.status = null;
});

describe("ComputerBrowserPane compact preview", () => {
  it("opens full screen and takes control from one tap", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const onOpenFullScreen = vi.fn();
    await act(async () => {
      renderer = create(
        <ComputerBrowserPane
          environmentId={EnvironmentId.make("env-1")}
          status={STATUS}
          events={[]}
          reachable
          compact
          onOpenFullScreen={onOpenFullScreen}
        />,
      );
    });

    const takeControl = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Take control"));
    expect(takeControl).toBeDefined();
    await act(async () => {
      takeControl!.props.onClick();
    });

    expect(onOpenFullScreen).toHaveBeenCalledTimes(1);
    expect(state.takeControl).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env-1"),
      input: {},
    });
  });
});

const IN_CONTROL: PersonalBrowserStatus = {
  ...STATUS,
  controller: { _tag: "Human", self: true, connected: true },
};

/** Stand-in for the offscreen field; react-test-renderer has no real DOM. */
function makeField() {
  return {
    value: "",
    focus: vi.fn(),
    blur: vi.fn(),
    setSelectionRange: vi.fn(),
  };
}

function touchEvent(pointerId: number, clientX: number, clientY: number) {
  return {
    pointerId,
    clientX,
    clientY,
    pointerType: "touch",
    currentTarget: { setPointerCapture: vi.fn(), focus: vi.fn() },
  };
}

describe("takeover keyboard", () => {
  const renderInControl = async (field: ReturnType<typeof makeField>) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    await act(async () => {
      renderer = create(
        <ComputerBrowserPane
          environmentId={EnvironmentId.make("env-1")}
          status={IN_CONTROL}
          events={[]}
          reachable
          fullScreen
        />,
        { createNodeMock: (element) => (element.type === "input" ? field : null) },
      );
    });
  };

  // Without this the phone sends a CDP click and nothing local is focused, so
  // iOS never raises its keyboard however typable the remote field is.
  it("focuses the offscreen field inside the tap handler", async () => {
    const field = makeField();
    await renderInControl(field);
    const canvas = renderer!.root.findByType("canvas");

    await act(async () => {
      canvas.props.onPointerDown(touchEvent(1, 10, 20));
      canvas.props.onPointerUp(touchEvent(1, 10, 20));
    });

    expect(field.focus).toHaveBeenCalledWith({ preventScroll: true });
    // Focus must stay on the field: moving it to the canvas dismisses the
    // keyboard on the very next tap.
    expect(canvas.props.tabIndex).toBe(0);
  });

  it("leaves the keyboard alone when the tap turned into a scroll", async () => {
    const field = makeField();
    await renderInControl(field);
    const canvas = renderer!.root.findByType("canvas");

    await act(async () => {
      canvas.props.onPointerDown(touchEvent(2, 10, 20));
      canvas.props.onPointerMove(touchEvent(2, 10, 200));
      canvas.props.onPointerUp(touchEvent(2, 10, 200));
    });

    expect(field.focus).not.toHaveBeenCalled();
  });

  it("toggles between showing and hiding the keyboard", async () => {
    const field = makeField();
    await renderInControl(field);
    const toggle = () =>
      renderer!.root
        .findAllByType("button")
        .find((button) => String(button.props["aria-label"]).endsWith(" keyboard"))!;

    expect(toggle().props["aria-label"]).toBe("Show keyboard");
    await act(async () => toggle().props.onClick());
    expect(field.focus).toHaveBeenCalledTimes(1);

    // The field reports its own focus; mirror what the browser would do.
    await act(async () => {
      renderer!.root.findByType("input").props.onFocus({ currentTarget: field });
    });
    expect(toggle().props["aria-label"]).toBe("Hide keyboard");

    await act(async () => toggle().props.onClick());
    expect(field.blur).toHaveBeenCalledTimes(1);
  });

  // The field is parked on a sentinel so that a Backspace on an otherwise
  // empty field is observable as "the value went empty" - iOS does not
  // reliably fire keydown for it.
  it("parks the offscreen field on a sentinel with the caret after it", async () => {
    const field = makeField();
    await renderInControl(field);
    const input = renderer!.root.findByType("input");

    await act(async () => {
      input.props.onFocus({ currentTarget: field });
    });
    expect(field.value).toBe("\u200b");
    expect(field.setSelectionRange).toHaveBeenCalledWith(1, 1);

    // A typed character arrives after the sentinel; the field is re-parked so
    // the next keystroke is measurable again.
    field.value = "\u200ba";
    await act(async () => {
      input.props.onInput({ currentTarget: field });
    });
    expect(field.value).toBe("\u200b");

    field.value = "";
    await act(async () => {
      input.props.onInput({ currentTarget: field });
    });
    expect(field.value).toBe("\u200b");
  });
});

describe("ComputerScreen back to chat", () => {
  const stubDocument = () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  };

  const tapBack = async (onBackToChat: (target: unknown) => void) => {
    await act(async () => {
      renderer = create(<ComputerScreen onBackToChat={onBackToChat} />);
    });
    const back = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Back to chat");
    expect(back).toBeDefined();
    await act(async () => back!.props.onClick());
  };

  /**
   * The bot's 90s agent lease lapses long before the browser's ten idle
   * minutes are up, so by the time the user looks away from the page and taps
   * Back the controller is usually `None`. It must still land in the chat that
   * opened the browser rather than on the chats list.
   */
  it("returns to the last agent's chat after its lease has lapsed", async () => {
    stubDocument();
    feedState.status = {
      ...STATUS,
      controller: { _tag: "None" },
      lastAgent: { threadId: ThreadId.make("thread-a"), botId: PersonalBotId.make("bot-1") },
    };
    const onBackToChat = vi.fn();
    await tapBack(onBackToChat);
    expect(onBackToChat).toHaveBeenCalledWith({ threadId: "thread-a", botId: "bot-1" });
  });

  it("falls back to the chats list when no bot has used the browser", async () => {
    stubDocument();
    feedState.status = { ...STATUS, controller: { _tag: "None" } };
    const onBackToChat = vi.fn();
    await tapBack(onBackToChat);
    expect(onBackToChat).toHaveBeenCalledWith(null);
  });
});
