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
  stop: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  approveEgress: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  refuseEgress: vi.fn(async () => ({ _tag: "Success", value: undefined })),
}));

const commands = vi.hoisted(() => ({
  takeControl: { label: "takeControl" },
  returnToAgent: { label: "returnToAgent" },
  close: { label: "close" },
  approveEgress: { label: "approveEgress" },
  refuseEgress: { label: "refuseEgress" },
}));

const NO_DESKTOP_EVENTS = vi.hoisted(() => []);
const desktopCommands = vi.hoisted(() => ({ stop: { label: "stop" } }));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === commands.takeControl) return state.takeControl;
    if (command === commands.returnToAgent) return state.returnToAgent;
    if (command === commands.approveEgress) return state.approveEgress;
    if (command === commands.refuseEgress) return state.refuseEgress;
    if (command === desktopCommands.stop) return state.stop;
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
  usePersonalBotsList: () => ({ data: null, error: null, refresh: () => undefined }),
}));
vi.mock("../usePersonalAutomation", () => ({
  usePersonalTasks: () => ({ tasks: null, error: null }),
}));
vi.mock("./PerformancePane", () => ({
  PerformancePane: (props: { botsBusy: number; tasksRunning: number }) => (
    <div
      data-testid="performance-pane"
      data-bots-busy={props.botsBusy}
      data-tasks-running={props.tasksRunning}
    />
  ),
}));
vi.mock("../SystemStatsLine", () => ({
  useSystemSummary: () => ({ cpuPct: 42, memUsedPct: 61 }),
}));
vi.mock("./viewportClient", () => ({ connectViewport: vi.fn() }));
const desktopState = vi.hoisted(() => ({ available: true as boolean | null }));
vi.mock("./desktopState", () => ({
  desktopEnvironment: desktopCommands,
  useDesktopActivity: () => NO_DESKTOP_EVENTS,
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
// react-test-renderer cannot render a portal: draw the sheet in place.
vi.mock("~/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetPopup: ({ children, ...props }: { children: ReactNode; "data-testid"?: string }) => (
    <div data-testid={props["data-testid"]}>{children}</div>
  ),
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  SheetClose: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
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

const windowStub = (extra: Record<string, unknown> = {}) => ({
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  localStorage: { getItem: () => null, setItem: vi.fn() },
  matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  ...extra,
});
const stubBrowserGlobals = () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", {
    visibilityState: "visible",
    body: { style: { overflow: "" } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", windowStub());
};
const renderScreen = async (props: Partial<Parameters<typeof ComputerScreen>[0]> = {}) => {
  await act(async () => {
    renderer = create(<ComputerScreen onBackToChat={vi.fn()} {...props} />, {
      createNodeMock: () => ({
        focus: vi.fn(),
        parentElement: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 244 }),
      }),
    });
  });
  return renderer!;
};
const buttonWith = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.findAllByType("span").some((span) => span.children.includes(label)));

describe("ComputerScreen take control", () => {
  it.each(["Browser", "Desktop"])("keeps one action for pending help on %s", async (source) => {
    stubBrowserGlobals();
    feedState.status = {
      ...STATUS,
      helpRequest: {
        threadId: ThreadId.make("thread-a"),
        botId: PersonalBotId.make("bot-1"),
        botName: "Developer",
        reason: "Please help with the page",
        requestedAt: "2026-09-15T10:00:00.000Z",
      },
    };
    await renderScreen();
    const tab = renderer!.root
      .findAllByProps({ role: "tab" })
      .find((node) => node.findAllByType("span").some((span) => span.children.includes(source)));
    await act(async () => tab!.props.onClick());
    const card = renderer!.root.findByProps({ "aria-label": "Developer needs you" });
    expect(
      card.findAllByType("p").some((node) => node.children.includes("Please help with the page")),
    ).toBe(true);
    expect(card.findAllByType("button").map((node) => node.children.join(""))).toEqual([
      "Open chat",
    ]);
    const actions = renderer!.root
      .findAllByType("button")
      .filter((node) =>
        node.findAllByType("span").some((span) => span.children.includes("Take control")),
      );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.props.disabled).toBeFalsy();
    await act(async () => actions[0]!.props.onClick());
    expect(state.takeControl).toHaveBeenCalledTimes(1);
  });

  it("opens full screen and takes control from one tap", async () => {
    stubBrowserGlobals();
    feedState.status = STATUS;
    await renderScreen();
    const take = buttonWith("Take control");
    expect(take).toBeDefined();
    await act(async () => {
      take!.props.onClick();
    });
    expect(state.takeControl).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env-1"),
      input: {},
    });
    expect(renderer!.root.findByProps({ "aria-label": "Computer full screen" }).props.role).toBe(
      "dialog",
    );
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
  const stubDocument = stubBrowserGlobals;

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
    vi.stubGlobal(
      "window",
      windowStub({
        addEventListener: vi.fn(
          (name: string, listener: typeof listeners extends Map<string, infer V> ? V : never) =>
            listeners.set(name, listener),
        ),
        removeEventListener: vi.fn((name: string) => listeners.delete(name)),
      }),
    );
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
    vi.stubGlobal("window", windowStub());
  };
  // The label sits in the tab's inner pill (the tab itself is the 44 px target).
  const tabText = (tab: ReactTestInstance) => String(tab.props["aria-label"]).split(",")[0];
  const tabs = () => renderer!.root.findAllByProps({ role: "tab" });

  it("offers Browser and Desktop, the PC's live view on Desktop, and Performance from the chip", async () => {
    stubDocument();
    feedState.status = STATUS;
    await act(async () => {
      renderer = create(<ComputerScreen onBackToChat={vi.fn()} />, {
        createNodeMock: () => ({ focus: vi.fn(), parentElement: null }),
      });
    });
    expect(tabs().map(tabText)).toEqual(["Browser", "Desktop"]);

    // Performance is a sheet behind the CPU/RAM chip and gets the app's busy counts.
    expect(renderer!.root.findAllByProps({ "data-testid": "performance-pane" })).toHaveLength(0);
    const chip = renderer!.root
      .findAllByType("button")
      .find((node) => String(node.props["aria-label"] ?? "").startsWith("Performance"));
    expect(chip).toBeDefined();
    await act(async () => chip!.props.onClick());
    // The pane is its own lazy chunk.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const performance = renderer!.root.findByProps({ "data-testid": "performance-pane" });
    expect(performance.props["data-bots-busy"]).toBe(0);
    expect(performance.props["data-tasks-running"]).toBe(0);

    const desktopTab = renderer!.root
      .findAllByProps({ role: "tab" })
      .find((tab) => tabText(tab) === "Desktop");
    await act(async () => desktopTab!.props.onClick());
    const pane = renderer!.root.findByProps({ "aria-label": "Desktop pane" });
    expect(pane.props["data-full-screen"]).toBe(false);

    // Full screen follows the browser's takeover: the same dialog.
    await act(async () => pane.props.onClick());
    expect(renderer!.root.findByProps({ "aria-label": "Computer full screen" }).props.role).toBe(
      "dialog",
    );
    expect(
      renderer!.root.findByProps({ "aria-label": "Desktop pane" }).props["data-full-screen"],
    ).toBe(true);
  });

  it("disables Desktop where the server has no desktop to show", async () => {
    stubDocument();
    desktopState.available = false;
    feedState.status = STATUS;
    await act(async () => {
      renderer = create(<ComputerScreen onBackToChat={vi.fn()} />);
    });
    const desktopTab = tabs().find((tab) => tabText(tab) === "Desktop");
    expect(desktopTab!.props.disabled).toBe(true);
  });
});

describe("control held by another device (1.60.45)", () => {
  const OTHER_DEVICE: PersonalBrowserStatus = {
    ...STATUS,
    controller: { _tag: "Human", self: false, connected: false },
  };

  const render = async (status: PersonalBrowserStatus) => {
    stubBrowserGlobals();
    feedState.status = status;
    await renderScreen();
  };

  it("offers Hand back in one tap, which returns the browser to its agent", async () => {
    await render(OTHER_DEVICE);
    const giveBack = buttonWith("Hand back");
    expect(giveBack).toBeDefined();
    await act(async () => {
      giveBack!.props.onClick();
    });
    expect(state.returnToAgent).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env-1"),
      input: {},
    });
    expect(state.takeControl).not.toHaveBeenCalled();
  });

  it("offers Take control, not Hand back, while the agent has the browser", async () => {
    await render(STATUS);
    expect(buttonWith("Hand back")).toBeUndefined();
    expect(buttonWith("Take control")).toBeDefined();
  });

  it("offers Hand back when this device holds control", async () => {
    await render(IN_CONTROL);
    expect(buttonWith("Take control")).toBeUndefined();
    expect(buttonWith("Hand back")).toBeDefined();
  });

  it("leaves Take control to the stage buttons while nothing is on screen", async () => {
    await render({ ...STATUS, state: "offline", controller: { _tag: "None" }, lastAgent: null });
    expect(buttonWith("Take control")).toBeUndefined();
    const stageButtons = renderer!.root
      .findAllByType("button")
      .map((node) => node.children.filter((child) => typeof child === "string").join(""));
    expect(stageButtons).toEqual(expect.arrayContaining(["Open Brave", "View desktop"]));
  });
});

const plainButton = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.children.filter((child) => typeof child === "string").join("") === label);

describe("sensitive-site pause (1.66.98)", () => {
  const PAUSED = {
    ...STATUS,
    egressPause: {
      threadId: "thread-a",
      botId: "bot-a",
      botName: "Assistant",
      sources: ["Chase", "Gmail"],
      destination: "slack.com",
      requestedAt: new Date().toISOString(),
    },
  } as unknown as PersonalBrowserStatus;

  it("shows the active bot's help card, never another thread's queued pause", async () => {
    stubBrowserGlobals();
    feedState.status = {
      ...STATUS,
      helpRequest: {
        threadId: ThreadId.make("thread-a"),
        botId: PersonalBotId.make("bot-1"),
        botName: "Developer",
        reason: "Please help with the page",
        requestedAt: "2026-09-15T10:00:00.000Z",
      },
      egressPause: {
        threadId: "thread-b",
        botId: "bot-b",
        botName: "Other",
        sources: ["Chase"],
        destination: "slack.com",
        requestedAt: "2026-09-15T10:00:01.000Z",
      },
    } as unknown as PersonalBrowserStatus;
    await renderScreen();

    expect(renderer!.root.findAllByProps({ "aria-label": "Developer needs you" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ "aria-label": "Allow this step?" })).toHaveLength(0);
    expect(plainButton("Allow once")).toBeUndefined();
  });

  it("sends Allow once and Refuse to the server for the paused chat", async () => {
    stubBrowserGlobals();
    feedState.status = PAUSED;
    await renderScreen();
    const allow = plainButton("Allow once");
    expect(allow).toBeDefined();
    await act(async () => {
      allow!.props.onClick();
    });
    expect(state.approveEgress).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env-1"),
      input: { threadId: "thread-a" },
    });
    const refuse = plainButton("Refuse");
    await act(async () => {
      refuse!.props.onClick();
    });
    expect(state.refuseEgress).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env-1"),
      input: { threadId: "thread-a" },
    });
  });
});
