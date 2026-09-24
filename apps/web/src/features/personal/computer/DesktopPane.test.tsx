import { EnvironmentId, type PersonalDesktopStatus } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DesktopViewCallbacks } from "./desktopViewClient";

const state = vi.hoisted(() => ({
  status: null as PersonalDesktopStatus | null,
  stop: vi.fn(async () => ({ _tag: "Success", value: undefined })),
  sockets: [] as Array<{
    url: string;
    callbacks: DesktopViewCallbacks;
    closed: boolean;
    viewports: Array<[number, number]>;
  }>,
}));

vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.stop }));
vi.mock("./computerState", () => ({
  refreshComputerAccess: vi.fn(),
  useComputerAccess: () => ({
    httpBase: "https://pc.example/api/personal/browser",
    wsBase: "wss://pc.example/api/personal/browser",
    query: { wsTicket: "ticket-1" },
    credentials: false,
  }),
}));
vi.mock("./desktopState", async () => {
  const actual = await vi.importActual<typeof import("./desktopState")>("./desktopState");
  return {
    ...actual,
    desktopEnvironment: { stop: { label: "stop" } },
    useDesktopStatus: () => state.status,
  };
});
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({}),
  createEnvironmentRpcSubscriptionAtomFamily: () => () => ({}),
}));
vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("./desktopViewClient", () => ({
  connectDesktopView: (url: string, callbacks: DesktopViewCallbacks) => {
    const socket = { url, callbacks, closed: false, viewports: [] as Array<[number, number]> };
    state.sockets.push(socket);
    return {
      setViewport: (width: number, height: number) => socket.viewports.push([width, height]),
      close: () => {
        socket.closed = true;
      },
    };
  },
}));

import { DesktopPane } from "./DesktopPane";

const IDLE: PersonalDesktopStatus = {
  available: true,
  holder: null,
  waiting: [],
  lastStop: null,
  stopHotkey: "Esc",
};
const HELD: PersonalDesktopStatus = {
  ...IDLE,
  holder: {
    threadId: "thread-1",
    botId: "bot-1",
    botName: "Assistant",
    since: "2026-09-24T07:00:00.000Z",
    lastActionAt: "2026-09-24T07:00:03.000Z",
  },
};

let renderer: ReactTestRenderer | undefined;
let visibility: "visible" | "hidden" = "visible";
const visibilityListeners = new Set<() => void>();
const drawImage = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility = "visible";
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (_name: string, listener: () => void) => visibilityListeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) =>
      visibilityListeners.delete(listener),
  });
  vi.stubGlobal("window", { setTimeout, clearTimeout, devicePixelRatio: 3 });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.sockets.length = 0;
  state.status = null;
  visibilityListeners.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const nodeMock = (element: { type: unknown }) =>
  element.type === "canvas"
    ? { width: 0, height: 0, getContext: () => ({ drawImage }) }
    : { getBoundingClientRect: () => ({ width: 390, height: 244 }) };

async function render(fullScreen = false) {
  await act(async () => {
    renderer = create(
      <DesktopPane
        environmentId={EnvironmentId.make("env-1")}
        fullScreen={fullScreen}
        onOpenFullScreen={vi.fn()}
        onExitFullScreen={vi.fn()}
      />,
      { createNodeMock: nodeMock },
    );
  });
  // The first connect runs on a zero-delay timer.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
}

const text = () => JSON.stringify(renderer!.toJSON());

type Node = { readonly children: ReadonlyArray<Node | string> };
const textOf = (node: Node | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const buttonLabels = () => renderer!.root.findAllByType("button").map((button) => textOf(button));

describe("DesktopPane live view", () => {
  it("opens one authenticated socket while the view is on screen, sized for the phone", async () => {
    state.status = IDLE;
    await render();
    expect(state.sockets).toHaveLength(1);
    expect(state.sockets[0]!.url).toBe(
      "wss://pc.example/api/personal/desktop/stream?wsTicket=ticket-1",
    );
    // 390 CSS px at 3x: the server fits the screen inside 1170 x 1170 device px.
    expect(state.sockets[0]!.viewports).toEqual([[1170, 1170]]);
    expect(text()).toContain("Connecting to your PC");
  });

  it("closes the socket when the page is hidden and reopens it when visible again", async () => {
    state.status = IDLE;
    await render();
    visibility = "hidden";
    await act(async () => {
      for (const listener of visibilityListeners) listener();
    });
    expect(state.sockets[0]!.closed).toBe(true);
    expect(state.sockets).toHaveLength(1);
    visibility = "visible";
    await act(async () => {
      for (const listener of visibilityListeners) listener();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(state.sockets).toHaveLength(2);
    expect(state.sockets[1]!.closed).toBe(false);
  });

  it("closes the socket when the view closes (unmount)", async () => {
    state.status = IDLE;
    await render();
    await act(async () => renderer?.unmount());
    renderer = undefined;
    expect(state.sockets[0]!.closed).toBe(true);
  });

  it("draws frames onto a canvas nobody can click through", async () => {
    state.status = IDLE;
    await render();
    const bitmap = { width: 1170, height: 731, close: vi.fn() };
    await act(async () => {
      state.sockets[0]!.callbacks.onFrame(bitmap as unknown as ImageBitmap, {
        width: 1170,
        height: 731,
      });
    });
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(bitmap.close).toHaveBeenCalled();
    expect(text()).not.toContain("Connecting to your PC");
    const canvas = renderer!.root.findByType("canvas");
    expect(canvas.props.className).toContain("pointer-events-none");
    for (const handler of ["onPointerDown", "onPointerUp", "onClick", "onKeyDown", "onWheel"]) {
      expect(canvas.props[handler]).toBeUndefined();
    }
    expect(canvas.props["aria-label"]).toContain("view only");
  });

  it("shows 'PC is locked' instead of frames", async () => {
    state.status = IDLE;
    await render();
    await act(async () => {
      state.sockets[0]!.callbacks.onFrame(
        { width: 10, height: 10, close: vi.fn() } as unknown as ImageBitmap,
        { width: 10, height: 10 },
      );
      state.sockets[0]!.callbacks.onState("locked", null);
    });
    expect(text()).toContain("PC is locked");
    const canvas = renderer!.root.findByType("canvas");
    expect(canvas.props.className).toContain("invisible");
    await act(async () => state.sockets[0]!.callbacks.onState("live", null));
    expect(text()).not.toContain("PC is locked");
  });

  it("says which bot holds the PC and stops it from the phone", async () => {
    state.status = HELD;
    await render();
    expect(text()).toContain("Assistant is using your PC");
    const stopButton = renderer!.root
      .findAllByType("button")
      .find((button) => textOf(button) === "Stop");
    expect(stopButton).toBeDefined();
    await act(async () => stopButton!.props.onClick());
    expect(state.stop).toHaveBeenCalledWith({ environmentId: "env-1", input: {} });
  });

  it("has no Stop while nobody holds the PC", async () => {
    state.status = IDLE;
    await render();
    expect(text()).toContain("No bot is using your PC");
    expect(buttonLabels()).not.toContain("Stop");
  });

  it("does not connect where there is no desktop to show", async () => {
    state.status = { ...IDLE, available: false };
    await render();
    expect(state.sockets).toHaveLength(0);
    expect(text()).toContain("No live view here");
  });

  it("going full screen and back keeps the same socket (no reconnect)", async () => {
    state.status = IDLE;
    await render();
    const pane = (fullScreen: boolean) => (
      <DesktopPane
        environmentId={EnvironmentId.make("env-1")}
        fullScreen={fullScreen}
        onOpenFullScreen={vi.fn()}
        onExitFullScreen={vi.fn()}
      />
    );
    await act(async () => renderer!.update(pane(true)));
    await act(async () => renderer!.update(pane(false)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(state.sockets).toHaveLength(1);
    expect(state.sockets[0]!.closed).toBe(false);
  });

  it("full screen: a way back and the frame box measured for the whole screen", async () => {
    state.status = IDLE;
    await render(true);
    expect(renderer!.root.findByProps({ "aria-label": "Exit full screen" })).toBeDefined();
    expect(state.sockets[0]!.viewports).toEqual([[1170, 732]]);
  });
});
