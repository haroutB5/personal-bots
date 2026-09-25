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
    regions: unknown[];
    sent: string[];
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
    const socket = {
      url,
      callbacks,
      closed: false,
      viewports: [] as Array<[number, number]>,
      regions: [] as unknown[],
      sent: [] as string[],
    };
    state.sockets.push(socket);
    return {
      setViewport: (width: number, height: number, region?: unknown) => {
        socket.viewports.push([width, height]);
        socket.regions.push(region);
      },
      send: (message: unknown) => socket.sent.push(JSON.stringify(message)),
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
/** Whether the phone is on its side (the compact landscape media query). */
let landscape = false;
const mediaListeners = new Set<() => void>();
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
  landscape = false;
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
    devicePixelRatio: 3,
    matchMedia: (query: string) => ({
      get matches() {
        return query.includes("landscape") && landscape;
      },
      addEventListener: (_name: string, listener: () => void) => mediaListeners.add(listener),
      removeEventListener: (_name: string, listener: () => void) => mediaListeners.delete(listener),
    }),
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.sockets.length = 0;
  state.status = null;
  visibilityListeners.clear();
  mediaListeners.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/**
 * The picture's on-screen rect: 390 x 243.75 CSS px from the top-left corner
 * of a 390 x 244 box, moved and scaled by whatever zoom it is rendered with.
 */
const pictureRect = () => {
  const transform =
    renderer?.root.findByProps({ "data-testid": "desktop-picture" }).props.style?.transform ?? "";
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(transform);
  const [x, y, scale] =
    match === null ? [0, 0, 1] : [Number(match[1]), Number(match[2]), Number(match[3])];
  return { left: x, top: y, width: 390 * scale, height: 243.75 * scale };
};

const nodeMock = (element: { type: unknown; props: unknown }) =>
  element.type === "canvas"
    ? {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage }),
        getBoundingClientRect: pictureRect,
      }
    : (element.props as Record<string, unknown>)["data-testid"] === "desktop-picture"
      ? { getBoundingClientRect: pictureRect }
      : {
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 244 }),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };

/** The picture's canvas (a second one holds zoomed-in frames). */
const pictureCanvas = () => renderer!.root.findAllByType("canvas")[0]!;
const regionCanvas = () => renderer!.root.findAllByType("canvas")[1]!;

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
    // The picture's 390 x 243.75 CSS px at 3x, all of the monitor.
    expect(state.sockets[0]!.viewports).toEqual([[1170, 731]]);
    expect(state.sockets[0]!.regions).toEqual([{ x: 0, y: 0, width: 1, height: 1 }]);
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
    const canvas = pictureCanvas();
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
    const canvas = pictureCanvas();
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

  it("full screen on its side: controls move to a rail, and rotating keeps the socket", async () => {
    state.status = HELD;
    await render(true);
    const root = () => renderer!.root.findAll((node) => node.props["data-layout"] !== undefined);
    expect(root()).toHaveLength(0);
    landscape = true;
    await act(async () => {
      for (const listener of mediaListeners) listener();
    });
    expect(root()[0]!.props["data-layout"]).toBe("rail");
    // Still the way back, the switch and Stop, and one socket.
    expect(renderer!.root.findByProps({ "aria-label": "Exit full screen" })).toBeDefined();
    expect(renderer!.root.findByProps({ role: "switch" })).toBeDefined();
    expect(buttonLabels()).toContain("Stop");
    expect(state.sockets).toHaveLength(1);
    expect(state.sockets[0]!.closed).toBe(false);
  });

  it("full screen: a way back and the frame box measured for the picture", async () => {
    state.status = IDLE;
    await render(true);
    expect(renderer!.root.findByProps({ "aria-label": "Exit full screen" })).toBeDefined();
    expect(state.sockets[0]!.viewports).toEqual([[1170, 731]]);
  });
});

const sentOf = (index = 0) => state.sockets[index]!.sent.map((text) => JSON.parse(text));

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 250)));

const viewSurface = () => renderer!.root.findByProps({ "data-testid": "desktop-view-surface" });

const touch = (id: number, x: number, y: number) => ({
  pointerType: "touch",
  pointerId: id,
  clientX: x,
  clientY: y,
  currentTarget: { setPointerCapture: vi.fn() },
  type: "pointerup",
});

/** A 3072x1920 monitor, drawn whole into 1170x731. */
const WHOLE_FRAME = {
  width: 1170,
  height: 731,
  region: { x: 0, y: 0, width: 3072, height: 1920 },
  screen: { width: 3072, height: 1920 },
};

async function drawFrame(frame: Parameters<DesktopViewCallbacks["onFrame"]>[1]) {
  await act(async () => {
    state.sockets[0]!.callbacks.onFrame(
      { width: frame.width, height: frame.height, close: vi.fn() } as unknown as ImageBitmap,
      frame,
    );
  });
}

describe("DesktopPane view-only zoom", () => {
  it("double tap zooms toward the point, never touching the PC, then asks for that region", async () => {
    state.status = IDLE;
    await renderPane(true);
    await drawFrame(WHOLE_FRAME);
    const surface = viewSurface();
    // No input surface for the PC while watching.
    expect(renderer!.root.findAllByProps({ role: "application" })).toHaveLength(0);
    await act(async () => {
      for (let tap = 0; tap < 2; tap += 1) {
        surface.props.onPointerDown(touch(3, 195, 121.875));
        surface.props.onPointerUp(touch(3, 195, 121.875));
      }
    });
    expect(pictureRect().width).toBeCloseTo(390 * 2.5);
    expect(renderer!.root.findByProps({ "aria-label": "Reset zoom" })).toBeDefined();
    await settle();
    // Nothing went to the PC: only the view changed.
    expect(sentOf()).toEqual([]);
    const region = state.sockets[0]!.regions.at(-1) as Record<string, number>;
    // The middle 40% of the monitor across, at the box's device pixels.
    expect(region.x).toBeCloseTo(0.3, 4);
    expect(region.width).toBeCloseTo(0.4, 4);
    expect(region.y).toBeCloseTo(0.3, 4);
    expect(state.sockets[0]!.viewports.at(-1)).toEqual([1170, 732]);

    // A second double tap goes back out, and back to whole frames.
    await act(async () => {
      for (let tap = 0; tap < 2; tap += 1) {
        surface.props.onPointerDown(touch(3, 100, 100));
        surface.props.onPointerUp(touch(3, 100, 100));
      }
    });
    await settle();
    expect(pictureRect().width).toBe(390);
    expect(renderer!.root.findAllByProps({ "aria-label": "Reset zoom" })).toHaveLength(0);
    expect(state.sockets[0]!.regions.at(-1)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(sentOf()).toEqual([]);
  });

  it("pinch zooms and one finger then pans, still sending the PC nothing", async () => {
    state.status = IDLE;
    await renderPane(true);
    await drawFrame(WHOLE_FRAME);
    const surface = viewSurface();
    await act(async () => {
      surface.props.onPointerDown(touch(1, 150, 120));
      surface.props.onPointerDown(touch(2, 240, 120));
      surface.props.onPointerMove(touch(1, 100, 120));
      surface.props.onPointerMove(touch(2, 290, 120));
      surface.props.onPointerUp(touch(1, 100, 120));
      surface.props.onPointerUp(touch(2, 290, 120));
    });
    const zoomed = pictureRect();
    expect(zoomed.width).toBeGreaterThan(390 * 1.5);
    await act(async () => {
      surface.props.onPointerDown(touch(4, 200, 120));
      surface.props.onPointerMove(touch(4, 240, 120));
      surface.props.onPointerMove(touch(4, 260, 120));
      surface.props.onPointerUp(touch(4, 260, 120));
    });
    expect(pictureRect().left).toBeGreaterThan(zoomed.left);
    await settle();
    expect(sentOf()).toEqual([]);
  });

  it("draws a zoomed-in frame over just its part of the picture", async () => {
    state.status = IDLE;
    await renderPane(true);
    await drawFrame(WHOLE_FRAME);
    expect(regionCanvas().props.style).toEqual({ display: "none" });
    await drawFrame({
      width: 1024,
      height: 640,
      region: { x: 1024, y: 640, width: 1024, height: 640 },
      screen: { width: 3072, height: 1920 },
    });
    const style = regionCanvas().props.style as Record<string, string>;
    expect(parseFloat(style.left!)).toBeCloseTo(100 / 3);
    expect(parseFloat(style.top!)).toBeCloseTo(100 / 3);
    expect(parseFloat(style.width!)).toBeCloseTo(100 / 3);
    // A whole frame again hides it.
    await drawFrame(WHOLE_FRAME);
    expect(regionCanvas().props.style).toEqual({ display: "none" });
  });
});

async function renderPane(fullScreen: boolean, onOpenFullScreen = vi.fn()) {
  await act(async () => {
    renderer = create(
      <DesktopPane
        environmentId={EnvironmentId.make("env-1")}
        fullScreen={fullScreen}
        onOpenFullScreen={onOpenFullScreen}
        onExitFullScreen={vi.fn()}
      />,
      { createNodeMock: nodeMock },
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  await act(async () => state.sockets[0]?.callbacks.onOpen());
}

const controlSwitch = () => renderer!.root.findByProps({ role: "switch" });

/** Full screen, control granted by the server, one frame drawn (1170x731 on a 390x244 box). */
async function inControl() {
  state.status = IDLE;
  await renderPane(true);
  await act(async () => {
    state.sockets[0]!.callbacks.onFrame(
      { width: 1170, height: 731, close: vi.fn() } as unknown as ImageBitmap,
      { width: 1170, height: 731 },
    );
  });
  await act(async () => controlSwitch().props.onClick());
  await act(async () => state.sockets[0]!.callbacks.onControl?.(true, null));
  return renderer!.root.findByProps({ role: "application" });
}

const pointer = (
  type: "touch" | "mouse",
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
) => ({
  pointerType: type,
  pointerId: type === "touch" ? 7 : 1,
  clientX: x,
  clientY: y,
  button: 0,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  currentTarget: { setPointerCapture: vi.fn(), focus: vi.fn() },
  preventDefault: vi.fn(),
  ...extra,
});

describe("DesktopPane remote control", () => {
  it("is off by default; turning it on from the inline view opens full screen first", async () => {
    state.status = IDLE;
    const onOpenFullScreen = vi.fn();
    await renderPane(false, onOpenFullScreen);
    expect(controlSwitch().props["aria-checked"]).toBe(false);
    expect(text()).toContain("View only");
    await act(async () => controlSwitch().props.onClick());
    expect(onOpenFullScreen).toHaveBeenCalled();
    // Not full screen yet: nothing asked of the PC.
    expect(sentOf()).toEqual([]);
  });

  it("in full screen asks the server for control and only then takes input", async () => {
    state.status = IDLE;
    await renderPane(true);
    await act(async () => controlSwitch().props.onClick());
    expect(sentOf()).toEqual([{ _tag: "Control", on: true }]);
    // Not granted yet: still no input surface.
    expect(renderer!.root.findAllByProps({ role: "application" })).toHaveLength(0);
    expect(text()).toContain("Taking control");
    await act(async () => state.sockets[0]!.callbacks.onControl?.(true, null));
    expect(renderer!.root.findAllByProps({ role: "application" })).toHaveLength(1);
    expect(text()).toContain("In control");
    expect(pictureCanvas().props["aria-label"]).toContain("in control");
  });

  it("a tap clicks the PC at the frame point under the finger", async () => {
    const surface = await inControl();
    await act(async () => {
      surface.props.onPointerDown(pointer("touch", 195, 121.875));
      surface.props.onPointerUp(pointer("touch", 195, 121.875));
    });
    const clicks = sentOf().filter((message) => message._tag === "Pointer");
    expect(clicks).toEqual([
      {
        _tag: "Pointer",
        action: "click",
        x: 585,
        y: 365.5,
        frameWidth: 1170,
        frameHeight: 731,
        button: "left",
      },
    ]);
  });

  it("with region frames a tap sends the monitor pixel under the finger, zoomed or not", async () => {
    const surface = await inControl();
    await drawFrame(WHOLE_FRAME);
    await act(async () => {
      surface.props.onPointerDown(pointer("touch", 195, 121.875));
      surface.props.onPointerUp(pointer("touch", 195, 121.875));
    });
    expect(sentOf().filter((message) => message._tag === "Pointer")).toEqual([
      {
        _tag: "Pointer",
        action: "click",
        x: 1536,
        y: 960,
        frameWidth: 3072,
        frameHeight: 1920,
        button: "left",
      },
    ]);

    // Pinch to zoom in, then a zoomed-in frame arrives.
    await act(async () => {
      surface.props.onPointerDown(pointer("touch", 150, 120, { pointerId: 1 }));
      surface.props.onPointerDown(pointer("touch", 240, 120, { pointerId: 2 }));
      surface.props.onPointerMove(pointer("touch", 60, 120, { pointerId: 1 }));
      surface.props.onPointerMove(pointer("touch", 330, 120, { pointerId: 2 }));
      surface.props.onPointerUp(pointer("touch", 60, 120, { pointerId: 1 }));
      surface.props.onPointerUp(pointer("touch", 330, 120, { pointerId: 2 }));
    });
    const rect = pictureRect();
    expect(rect.width).toBeGreaterThan(390 * 2);
    await drawFrame({
      width: 1170,
      height: 731,
      region: { x: 1000, y: 600, width: 1200, height: 750 },
      screen: { width: 3072, height: 1920 },
    });
    // Much later (no double click), tap a point: it maps through the zoom,
    // not through whichever frame is on screen.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    await act(async () => {
      surface.props.onPointerDown(pointer("touch", 101, 57, { pointerId: 9 }));
      surface.props.onPointerUp(pointer("touch", 101, 57, { pointerId: 9 }));
    });
    const tap = sentOf().findLast((message) => message._tag === "Pointer");
    expect(tap).toMatchObject({
      action: "click",
      x: Math.floor(((101 - rect.left) / rect.width) * 3072),
      y: Math.floor(((57 - rect.top) / rect.height) * 1920),
      frameWidth: 3072,
      frameHeight: 1920,
    });
  });

  it("a mouse presses, moves and releases straight through, and keys go to the PC", async () => {
    const surface = await inControl();
    await act(async () => {
      surface.props.onPointerDown(pointer("mouse", 39, 24.4, { button: 2 }));
      surface.props.onPointerUp(pointer("mouse", 39, 24.4, { button: 2 }));
    });
    const pointers = sentOf().filter((message) => message._tag === "Pointer");
    expect(pointers.map((message) => [message.action, message.button])).toEqual([
      ["down", "right"],
      ["up", "right"],
    ]);
    const escape = {
      key: "Escape",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => surface.props.onKeyDown(escape));
    expect(sentOf().at(-1)).toEqual({ _tag: "Keys", keys: "esc" });
    // Esc is the PC's: it must not also close full screen.
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(escape.stopPropagation).toHaveBeenCalled();
  });

  it("the special keys row sends combos, with sticky modifiers used once", async () => {
    await inControl();
    const key = (label: string) => renderer!.root.findByProps({ "aria-label": label });
    await act(async () => key("Copy (Ctrl+C)").props.onClick());
    expect(sentOf().at(-1)).toEqual({ _tag: "Keys", keys: "ctrl+c" });
    await act(async () => key("Alt (sticky)").props.onClick());
    expect(key("Alt (sticky)").props["aria-pressed"]).toBe(true);
    await act(async () => key("Tab").props.onClick());
    expect(sentOf().at(-1)).toEqual({ _tag: "Keys", keys: "alt+tab" });
    expect(key("Alt (sticky)").props["aria-pressed"]).toBe(false);
    await act(async () => key("Tab").props.onClick());
    expect(sentOf().at(-1)).toEqual({ _tag: "Keys", keys: "tab" });
    await act(async () => key("Start menu (Win)").props.onClick());
    expect(sentOf().at(-1)).toEqual({ _tag: "Keys", keys: "win" });
  });

  it("typing on the phone keyboard sends text, and an emptied field is a Backspace", async () => {
    await inControl();
    const field = renderer!.root.findByProps({ "aria-label": "Type on your PC" });
    const target = { value: "​hello", setSelectionRange: vi.fn() };
    await act(async () => field.props.onInput({ currentTarget: target }));
    expect(sentOf().at(-1)).toEqual({ _tag: "Text", text: "hello" });
    target.value = "";
    await act(async () => field.props.onInput({ currentTarget: target }));
    expect(sentOf().at(-1)).toEqual({ _tag: "Keys", keys: "backspace" });
  });

  it("control ended by the server says why and turns the switch off", async () => {
    await inControl();
    await act(async () =>
      state.sockets[0]!.callbacks.onControl?.(
        false,
        "Remote control ended after 2 minutes without input.",
      ),
    );
    expect(controlSwitch().props["aria-checked"]).toBe(false);
    expect(renderer!.root.findAllByProps({ role: "application" })).toHaveLength(0);
    expect(text()).toContain("Remote control ended after 2 minutes without input.");
  });

  it("a PC that locks ends control, says it can't be unlocked remotely, and disables the switch", async () => {
    await inControl();
    await act(async () => state.sockets[0]!.callbacks.onState("locked", null));
    expect(sentOf().at(-1)).toEqual({ _tag: "Control", on: false });
    expect(text()).toContain("PC is locked; it can't be unlocked remotely.");
    expect(controlSwitch().props.disabled).toBe(true);
    expect(renderer!.root.findAllByProps({ role: "application" })).toHaveLength(0);
  });

  it("leaving full screen hands control back", async () => {
    await inControl();
    await act(async () =>
      renderer!.update(
        <DesktopPane
          environmentId={EnvironmentId.make("env-1")}
          fullScreen={false}
          onOpenFullScreen={vi.fn()}
          onExitFullScreen={vi.fn()}
        />,
      ),
    );
    expect(sentOf().at(-1)).toEqual({ _tag: "Control", on: false });
    expect(controlSwitch().props["aria-checked"]).toBe(false);
  });

  it("while the owner controls the PC there is no Stop for it, and the line says so", async () => {
    state.status = {
      ...IDLE,
      holder: {
        threadId: "remote-user",
        botId: "",
        botName: "You",
        since: "2026-09-24T07:00:00.000Z",
        lastActionAt: "2026-09-24T07:00:03.000Z",
        kind: "user",
      },
    };
    await renderPane(false);
    expect(text()).toContain("You are controlling your PC");
    expect(buttonLabels()).not.toContain("Stop");
  });
});
