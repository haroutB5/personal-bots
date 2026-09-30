import type { ReactNode } from "react";

import {
  EnvironmentId,
  PersonalBotId,
  ThreadId,
  type PersonalBrowserStatus,
} from "@t3tools/contracts";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  addressBarValue,
  ComputerBrowserPane,
  ComputerScreen,
  insertTextChunks,
  keyboardInputMode,
  PageDialogCard,
} from "./ComputerScreen";

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
vi.mock("../overlayInert", () => ({ inertOutside: vi.fn(() => vi.fn()) }));
vi.mock("~/state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, refresh: vi.fn() }),
}));
vi.mock("../usePersonalBots", () => ({
  usePersonalEnvironmentId: () => EnvironmentId.make("env-1"),
}));
vi.mock("./viewportClient", () => ({ connectViewport: vi.fn() }));
const desktopState = vi.hoisted(() => ({ available: true as boolean | null }));
vi.mock("./desktopState", () => ({
  useDesktopStatus: () =>
    desktopState.available === null
      ? null
      : {
          available: desktopState.available,
          holder: null,
          waiting: [],
          lastStop: null,
          stopHotkey: "Esc",
        },
}));
vi.mock("./DesktopPane", () => ({
  DesktopPane: (props: { fullScreen: boolean; onOpenFullScreen: () => void }) => (
    <button
      type="button"
      aria-label="Desktop pane"
      data-full-screen={props.fullScreen}
      onClick={props.onOpenFullScreen}
    />
  ),
}));
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
  desktopState.available = true;
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

describe("address bar after a failed navigation", () => {
  const errored = (url: string): PersonalBrowserStatus["page"] => ({
    url,
    title: "example.com",
  });

  it("offers nothing back when Chrome is on its own error page", () => {
    // Submitting the seeded value used to send `chrome-error://chromewebdata/`,
    // which the server rejects as an unsupported protocol.
    expect(addressBarValue(errored("chrome-error://chromewebdata/"))).toBe("");
    expect(addressBarValue(errored("about:blank"))).toBe("");
    expect(addressBarValue(null)).toBe("");
    expect(addressBarValue(errored("https://example.com/"))).toBe("https://example.com/");
  });
});

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
    preventDefault: vi.fn(),
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

  // The canvas is focusable for hardware keys, so a tap's compatibility
  // mousedown focused it straight after the field and iOS dropped the keyboard
  // (v1.59, Harout's iPhone). Cancelling the touch's pointerdown stops that.
  it("cancels a touch's pointerdown so the tap cannot focus the canvas", async () => {
    const field = makeField();
    await renderInControl(field);
    const canvas = renderer!.root.findByType("canvas");
    const down = touchEvent(3, 10, 20);
    await act(async () => {
      canvas.props.onPointerDown(down);
    });
    expect(down.preventDefault).toHaveBeenCalled();
    expect(down.currentTarget.focus).not.toHaveBeenCalled();
  });

  it("sends IME and dictation text once, when the composition ends", async () => {
    const field = makeField();
    await renderInControl(field);
    const input = renderer!.root.findByType("input");
    await act(async () => {
      input.props.onFocus({ currentTarget: field });
      input.props.onCompositionStart();
    });
    // Mid-composition input is the IME's, not the page's: the field is not re-parked.
    field.value = "\u200bnih";
    await act(async () => {
      input.props.onInput({ currentTarget: field, nativeEvent: { isComposing: true } });
    });
    expect(field.value).toBe("\u200bnih");
    field.value = "\u200b\u4f60\u597d";
    await act(async () => {
      input.props.onCompositionEnd({ currentTarget: field });
    });
    expect(field.value).toBe("\u200b");
  });

  it("pastes as text, in pieces the server accepts", async () => {
    const field = makeField();
    await renderInControl(field);
    const input = renderer!.root.findByType("input");
    const preventDefault = vi.fn();
    await act(async () => {
      input.props.onPaste({
        clipboardData: { getData: () => "pasted" },
        preventDefault,
      });
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(insertTextChunks("x".repeat(9_000)).map((chunk) => chunk.length)).toEqual([
      4_000, 4_000, 1_000,
    ]);
    expect(insertTextChunks("")).toEqual([]);
  });

  it("asks for the keyboard that matches the remote field", () => {
    expect(keyboardInputMode("email")).toBe("email");
    expect(keyboardInputMode("decimal")).toBe("decimal");
    expect(keyboardInputMode("numeric")).toBe("numeric");
    expect(keyboardInputMode("password")).toBe("text");
    expect(keyboardInputMode(undefined)).toBe("text");
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
      input.props.onInput({ currentTarget: field, nativeEvent: {} });
    });
    expect(field.value).toBe("\u200b");

    field.value = "";
    await act(async () => {
      input.props.onInput({ currentTarget: field, nativeEvent: {} });
    });
    expect(field.value).toBe("\u200b");
  });
});

describe("page dialog", () => {
  const confirmDialog = {
    type: "confirm" as const,
    message: "Really delete store?",
    defaultValue: "",
  };

  it("shows the page's dialog over the live view, answerable only in control", async () => {
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
          status={{ ...STATUS, dialog: confirmDialog }}
          events={[]}
          reachable
        />,
      );
    });
    const card = renderer!.root.findByType(PageDialogCard);
    expect(card.props.canAnswer).toBe(false);
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Really delete store?");
    expect(text).toContain("Take control to answer it.");
  });

  it("answers OK, Cancel, and a prompt's text", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onAnswer = vi.fn();
    await act(async () => {
      renderer = create(<PageDialogCard dialog={confirmDialog} canAnswer onAnswer={onAnswer} />);
    });
    const buttons = () => renderer!.root.findAllByType("button");
    expect(buttons().map((button) => button.children.join(""))).toEqual(["Cancel", "OK"]);
    await act(async () => buttons()[0]!.props.onClick());
    await act(async () => buttons()[1]!.props.onClick());
    expect(onAnswer.mock.calls).toEqual([[false], [true, undefined]]);

    onAnswer.mockClear();
    await act(async () => {
      renderer!.update(
        <PageDialogCard
          dialog={{ type: "prompt", message: "Store name?", defaultValue: "a" }}
          canAnswer
          onAnswer={onAnswer}
        />,
      );
    });
    const field = renderer!.root.findByType("input");
    await act(async () => field.props.onChange({ currentTarget: { value: "my-store" } }));
    await act(async () => buttons()[1]!.props.onClick());
    expect(onAnswer).toHaveBeenCalledWith(true, "my-store");
  });

  it("words a leave-page dialog as leave or stay", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {
      renderer = create(
        <PageDialogCard
          dialog={{ type: "beforeunload", message: "", defaultValue: "" }}
          canAnswer
          onAnswer={vi.fn()}
        />,
      );
    });
    expect(
      renderer!.root.findAllByType("button").map((button) => button.children.join("")),
    ).toEqual(["Stay", "Leave page"]);
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

  const tapBack = async (
    onBackToChat: (target: unknown) => void,
    origin: { botId: string; threadId: string } | null = null,
  ) => {
    await act(async () => {
      renderer = create(<ComputerScreen onBackToChat={onBackToChat} origin={origin} />);
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

  /**
   * The reported bug. He taps the chat's Computer line, finds "Browser not
   * running / No page open", and taps Back: no controller and no `lastAgent`,
   * so the status alone would send him to the chats list. The chat's link
   * carries its own origin for exactly this case.
   */
  it("returns to the originating chat when the browser never ran", async () => {
    stubDocument();
    feedState.status = {
      ...STATUS,
      state: "offline",
      controller: { _tag: "None" },
      lastAgent: null,
    };
    const onBackToChat = vi.fn();
    await tapBack(onBackToChat, { botId: "bot-1", threadId: "thread-a" });
    expect(onBackToChat).toHaveBeenCalledWith({ botId: "bot-1", threadId: "thread-a" });
  });
});

describe("ComputerScreen full screen", () => {
  it("expands the browser over the app and exits without navigating away", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const listeners = new Map<
      string,
      (event: { key?: string; preventDefault: () => void }) => void
    >();
    vi.stubGlobal("document", {
      visibilityState: "visible",
      body: { style: { overflow: "" } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(
        (name: string, listener: typeof listeners extends Map<string, infer V> ? V : never) =>
          listeners.set(name, listener),
      ),
      removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    });
    feedState.status = STATUS;
    const onBackToChat = vi.fn();
    await act(async () => {
      renderer = create(<ComputerScreen onBackToChat={onBackToChat} />, {
        createNodeMock: () => ({ focus: vi.fn(), parentElement: null }),
      });
    });
    const expand = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Open browser full screen");
    expect(expand).toBeDefined();
    await act(async () => expand!.props.onClick());
    expect(renderer!.root.findByProps({ "aria-label": "Computer full screen" }).props.role).toBe(
      "dialog",
    );
    expect(document.body.style.overflow).toBe("hidden");

    const exit = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Exit full screen");
    expect(exit).toBeDefined();
    await act(async () => exit!.props.onClick());
    expect(onBackToChat).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("");
  });
});

describe("ComputerScreen Desktop segment", () => {
  const stubDocument = () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", {
      visibilityState: "visible",
      body: { style: { overflow: "" } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  };
  // The label sits in the tab's inner pill (the tab itself is the 44 px target).
  const tabText = (tab: ReactTestInstance) => String(tab.findByType("span").props.children);
  const tabs = () => renderer!.root.findAllByProps({ role: "tab" }).map(tabText);

  it("offers Browser, Desktop and Files, and shows the PC's live view on Desktop", async () => {
    stubDocument();
    feedState.status = STATUS;
    await act(async () => {
      renderer = create(<ComputerScreen onBackToChat={vi.fn()} />, {
        createNodeMock: () => ({ focus: vi.fn(), parentElement: null }),
      });
    });
    expect(tabs()).toEqual(["Browser", "Desktop", "Files"]);
    expect(renderer!.root.findAllByProps({ "aria-label": "Desktop pane" })).toHaveLength(0);
    const desktopTab = renderer!.root
      .findAllByProps({ role: "tab" })
      .find((tab) => tabText(tab) === "Desktop");
    await act(async () => desktopTab!.props.onClick());
    const pane = renderer!.root.findByProps({ "aria-label": "Desktop pane" });
    expect(pane.props["data-full-screen"]).toBe(false);
    // The browser's socket is gone: only one live view runs at a time.
    expect(
      renderer!.root.findAllByProps({ "aria-label": "Open browser full screen" }),
    ).toHaveLength(0);

    // Full screen follows the browser's takeover: the same dialog.
    await act(async () => pane.props.onClick());
    expect(renderer!.root.findByProps({ "aria-label": "Computer full screen" }).props.role).toBe(
      "dialog",
    );
    expect(
      renderer!.root.findByProps({ "aria-label": "Desktop pane" }).props["data-full-screen"],
    ).toBe(true);
  });

  it("leaves Desktop out where the server has no desktop to show", async () => {
    stubDocument();
    desktopState.available = false;
    feedState.status = STATUS;
    await act(async () => {
      renderer = create(<ComputerScreen onBackToChat={vi.fn()} />);
    });
    expect(tabs()).toEqual(["Browser", "Files"]);
  });
});
