import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ChatChips } from "./ChatChips";
import { CURRENT_CHIP_SELECTOR } from "./chatChipNavigation";
import type { ChatChip } from "./chatChipRows";
import { CHAT_SETTINGS_HINT } from "./chatSettingsModel";
import { LONG_PRESS_MS } from "./useLongPress";

const chip = (threadId: string, current = false): ChatChip => ({
  threadId,
  text: `Chat ${threadId}`,
  kind: "chat",
  current,
  state: "idle",
  unread: false,
  pinned: false,
  label: current ? `Chat ${threadId}, current chat` : `Chat ${threadId}`,
});

interface FakeAnchor {
  readonly offsetLeft: number;
  readonly offsetWidth: number;
  readonly props: Record<string, unknown>;
}

const listeners = new Map<string, Set<(event: unknown) => void>>();
let activeElement: { hasAttribute: (name: string) => boolean } | null = null;

/** Dispatches to the document listeners; true when something swallowed the event. */
function fire(type: string): boolean {
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  return event.preventDefault.mock.calls.length > 0;
}

const pointer = (x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({
    clientX: x,
    clientY: y,
    pointerType: "touch",
    button: 0,
    preventDefault: vi.fn(),
    ...extra,
  }) as never;

let renderer: ReactTestRenderer | undefined;
let setHostChips: (chips: ChatChip[]) => void = () => {};
let setHostEpoch: (epoch: number) => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  activeElement = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderChips(
  options: {
    chips?: ChatChip[];
    onChipSettings?: (threadId: string, opener: HTMLElement | null) => void;
    onNewChat?: () => void;
    /** Where each chip sits in the row (offsetLeft); the others sit at 0. */
    offsets?: Record<string, number>;
    row?: { scrollLeft: number };
    /** The open chat's id, which the route carries (default t2). */
    current?: string;
  } = {},
) {
  const anchors = new Map<string, FakeAnchor>();
  const scrollTo = vi.fn();
  const row = {
    clientWidth: 300,
    scrollLeft: options.row?.scrollLeft ?? 0,
    scrollWidth: 800,
    scrollTo,
    querySelector: (selector: string) => {
      if (selector === CURRENT_CHIP_SELECTOR) {
        return (
          [...anchors.values()].find((anchor) => anchor.props["aria-current"] === "page") ?? null
        );
      }
      const match = /^\[data-chip-id="(.+)"\]$/.exec(selector);
      return match === null ? null : (anchors.get(match[1]!) ?? null);
    },
    querySelectorAll: () => [],
  };
  function Host() {
    const [chips, setChips] = useState(options.chips ?? [chip("t1"), chip("t2", true), chip("t3")]);
    const [epoch, setEpoch] = useState(0);
    setHostChips = setChips;
    setHostEpoch = setEpoch;
    return (
      <ChatChips
        botId="b1"
        botName="Backend"
        chips={chips}
        openCount={chips.length}
        onNewChat={options.onNewChat ?? (() => {})}
        onChipSettings={options.onChipSettings}
        resortEpoch={epoch}
      />
    );
  }
  const root = createRootRoute({ component: Host });
  const routes = ["/bots/$botId", "/bots/$botId/$threadId"].map((path) =>
    createRoute({ getParentRoute: () => root, path }),
  );
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [`/bots/b1/${options.current ?? "t2"}`] }),
  });
  await router.load();
  // Stubbed once the router exists: with a window the router would try to be a browser's.
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", {
    get activeElement() {
      return activeElement;
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
  });
  await act(async () => {
    renderer = create(<RouterProvider router={router} />, {
      createNodeMock: (element) => {
        if (element.type === "a") {
          const props = element.props as Record<string, unknown>;
          const id = String(props["data-chip-id"] ?? props["aria-label"]);
          // Read live: a test moves a chip by changing its entry before it re-renders the row.
          const anchor: FakeAnchor = {
            get offsetLeft() {
              return options.offsets?.[id] ?? 0;
            },
            offsetWidth: 80,
            props,
          };
          anchors.set(String(props["data-chip-id"] ?? props["aria-label"]), anchor);
          return anchor;
        }
        return element.type === "div" ? row : null;
      },
    });
  });
  return { tree: renderer!, scrollTo, row };
}

const chipLink = (tree: ReactTestRenderer, id: string): ReactTestInstance =>
  tree.root.find((node) => node.type === "a" && node.props["data-chip-id"] === id);
const plusButton = (tree: ReactTestRenderer) =>
  tree.root.find(
    (node) => node.type === "button" && String(node.props["aria-label"]).startsWith("New chat"),
  );
const allLink = (tree: ReactTestRenderer) =>
  tree.root.find(
    (node) => node.type === "a" && String(node.props["aria-label"]).startsWith("All chats"),
  );

describe("holding a chip", () => {
  it("opens that chip's settings after 500 ms, and does not switch", async () => {
    const onChipSettings = vi.fn();
    const { tree } = await renderChips({ onChipSettings });
    const t1 = chipLink(tree, "t1");
    await act(async () => t1.props.onPointerDown(pointer(10, 10)));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    });
    expect(onChipSettings).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(onChipSettings).toHaveBeenCalledTimes(1);
    expect(onChipSettings.mock.calls[0]![0]).toBe("t1");
    // The opener is the chip itself, so focus can go back to it.
    expect(onChipSettings.mock.calls[0]![1]).not.toBeNull();
    // The click that ends the hold is eaten wherever it lands: the chip never switches.
    await act(async () => t1.props.onPointerUp());
    expect(fire("click")).toBe(true);
  });

  it("a tap under 500 ms opens nothing and leaves the click to the link", async () => {
    const onChipSettings = vi.fn();
    const { tree } = await renderChips({ onChipSettings });
    const t1 = chipLink(tree, "t1");
    await act(async () => t1.props.onPointerDown(pointer(10, 10)));
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    await act(async () => t1.props.onPointerUp());
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(onChipSettings).not.toHaveBeenCalled();
    expect(fire("click")).toBe(false);
    // Nothing was held back: the chip's own tap (the router's link click) is not eaten or prevented.
    const down = pointer(10, 10);
    await act(async () => t1.props.onPointerDown(down));
    expect(
      (down as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault,
    ).not.toHaveBeenCalled();
    await act(async () => t1.props.onPointerUp());
    expect(fire("click")).toBe(false);
  });

  it("a scroll never opens it: 8 px of drift, or the browser taking the pan", async () => {
    const onChipSettings = vi.fn();
    const { tree } = await renderChips({ onChipSettings });
    const t1 = chipLink(tree, "t1");
    await act(async () => t1.props.onPointerDown(pointer(10, 10)));
    await act(async () => t1.props.onPointerMove(pointer(20, 10)));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(onChipSettings).not.toHaveBeenCalled();

    await act(async () => t1.props.onPointerDown(pointer(10, 10)));
    await act(async () => t1.props.onPointerCancel());
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(onChipSettings).not.toHaveBeenCalled();
    expect(fire("click")).toBe(false);
  });

  it("holding the open chip opens its settings too", async () => {
    const onChipSettings = vi.fn();
    const { tree } = await renderChips({ onChipSettings });
    const t2 = chipLink(tree, "t2");
    await act(async () => t2.props.onPointerDown(pointer(10, 10)));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onChipSettings.mock.calls.map((call) => call[0])).toEqual(["t2"]);
  });

  it("keeps the composer's keyboard up and still counts the hold (both pointer-down handlers run)", async () => {
    activeElement = { hasAttribute: (name) => name === "data-chat-composer-input" };
    const onChipSettings = vi.fn();
    const { tree } = await renderChips({ onChipSettings });
    const event = pointer(10, 10);
    await act(async () => chipLink(tree, "t1").props.onPointerDown(event));
    expect(
      (event as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault,
    ).toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onChipSettings).toHaveBeenCalledTimes(1);
  });

  it("leaves + and All alone: no hold on them", async () => {
    const onChipSettings = vi.fn();
    const onNewChat = vi.fn();
    const { tree } = await renderChips({ onChipSettings, onNewChat });
    for (const control of [plusButton(tree), allLink(tree)]) {
      expect(control.props.onPointerMove).toBeUndefined();
      expect(control.props.onContextMenu).toBeUndefined();
      expect(control.props["aria-describedby"]).toBeUndefined();
    }
    await act(async () => plusButton(tree).props.onPointerDown(pointer(10, 10)));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(onChipSettings).not.toHaveBeenCalled();
    await act(async () => plusButton(tree).props.onClick());
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("shows the hold on the pressed chip only: holding, then held for a moment, then nothing", async () => {
    const { tree } = await renderChips({ onChipSettings: vi.fn() });
    const state = (id: string) => {
      const props = chipLink(tree, id).props;
      return [props["data-holding"], props["data-held"]];
    };
    expect(state("t1")).toEqual([undefined, undefined]);
    await act(async () => chipLink(tree, "t1").props.onPointerDown(pointer(10, 10)));
    expect(state("t1")).toEqual(["true", undefined]);
    expect(state("t3")).toEqual([undefined, undefined]);
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(state("t1")).toEqual([undefined, "true"]);
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(state("t1")).toEqual([undefined, undefined]);
  });

  it("drops the cue when the press is cancelled", async () => {
    const { tree } = await renderChips({ onChipSettings: vi.fn() });
    await act(async () => chipLink(tree, "t1").props.onPointerDown(pointer(10, 10)));
    expect(chipLink(tree, "t1").props["data-holding"]).toBe("true");
    await act(async () => chipLink(tree, "t1").props.onPointerCancel());
    expect(chipLink(tree, "t1").props["data-holding"]).toBeUndefined();
  });
});

describe("the other ways in", () => {
  it("right-click opens the chip's settings and holds back the browser's menu", async () => {
    const onChipSettings = vi.fn();
    const { tree } = await renderChips({ onChipSettings });
    const event = { preventDefault: vi.fn() };
    await act(async () => chipLink(tree, "t3").props.onContextMenu(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onChipSettings.mock.calls.map((call) => call[0])).toEqual(["t3"]);
  });

  it("a context menu after a hold (Android) asks for the same chat, so opening twice is the same sheet", async () => {
    const onChipSettings = vi.fn();
    const { tree } = await renderChips({ onChipSettings });
    await act(async () => chipLink(tree, "t1").props.onPointerDown(pointer(10, 10)));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    await act(async () => chipLink(tree, "t1").props.onContextMenu({ preventDefault: vi.fn() }));
    expect(new Set(onChipSettings.mock.calls.map((call) => call[0]))).toEqual(new Set(["t1"]));
  });

  it("ContextMenu and Shift+F10 on a focused chip open its settings; plain F10 does not", async () => {
    const onChipSettings = vi.fn();
    const { tree } = await renderChips({ onChipSettings });
    const rowDiv = tree.root.find(
      (node) => node.type === "div" && node.props.className === "personal-chip-row",
    );
    const focused = { getAttribute: (name: string) => (name === "data-chip-id" ? "t1" : null) };
    const key = (init: Record<string, unknown>) => ({
      preventDefault: vi.fn(),
      target: focused,
      currentTarget: { querySelectorAll: () => [] },
      shiftKey: false,
      ...init,
    });
    const menuKey = key({ key: "ContextMenu" });
    await act(async () => rowDiv.props.onKeyDown(menuKey));
    expect(menuKey.preventDefault).toHaveBeenCalled();
    const shiftF10 = key({ key: "F10", shiftKey: true });
    await act(async () => rowDiv.props.onKeyDown(shiftF10));
    expect(onChipSettings.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["t1", focused],
      ["t1", focused],
    ]);
    const plain = key({ key: "F10" });
    await act(async () => rowDiv.props.onKeyDown(plain));
    expect(onChipSettings).toHaveBeenCalledTimes(2);
    // The + button has no chip id: the key does nothing there.
    const onPlus = key({ key: "ContextMenu", target: { getAttribute: () => null } });
    await act(async () => rowDiv.props.onKeyDown(onPlus));
    expect(onChipSettings).toHaveBeenCalledTimes(2);
    expect(onPlus.preventDefault).not.toHaveBeenCalled();
  });

  it("tells a screen reader about the hold once, for every chip", async () => {
    const { tree } = await renderChips({ onChipSettings: vi.fn() });
    const hint = tree.root.find((node) => node.type === "span" && node.props.hidden === true);
    expect(hint.children).toEqual([CHAT_SETTINGS_HINT]);
    const described = ["t1", "t2", "t3"].map((id) => chipLink(tree, id).props["aria-describedby"]);
    expect(new Set(described)).toEqual(new Set([hint.props.id]));
    // The chip's own label is unchanged.
    expect(chipLink(tree, "t2").props["aria-label"]).toBe("Chat t2, current chat");
  });

  it("is not a draggable link, so iOS has no link preview to offer for the hold", async () => {
    const { tree } = await renderChips({ onChipSettings: vi.fn() });
    expect(chipLink(tree, "t1").props.draggable).toBe(false);
  });
});

describe("centring the open chip", () => {
  it("is instant the first time and after an order re-taken on return, smooth after a switch", async () => {
    const { scrollTo } = await renderChips();
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "instant" }));
    // A new chip arrives while he stays: the row re-centres smoothly.
    await act(async () => setHostChips([chip("t0"), chip("t1"), chip("t2", true), chip("t3")]));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "smooth" }));
    // The app came back after a while and the order was re-taken: at once.
    await act(async () => setHostEpoch(1));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "instant" }));
    await act(async () => setHostChips([chip("t1"), chip("t2", true), chip("t3")]));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });
});

describe("the row follows a pin", () => {
  const pinned = (threadId: string, current = false): ChatChip => ({
    ...chip(threadId, current),
    pinned: true,
  });
  // Ten chats in a row 300 px wide, 86 px apart; the open one is t8, far from the front.
  const ids = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"];
  const place = (order: ReadonlyArray<string> = ids) =>
    Object.fromEntries(order.map((id, at) => [id, 3 + at * 86]));
  const row = (changed: ChatChip[] = []) =>
    ids.map(
      (id) => changed.find((candidate) => candidate.threadId === id) ?? chip(id, id === "t8"),
    );
  /** `lead` leads the row (pinned), the rest follow in order. */
  const withFront = (lead: string) => [
    pinned(lead, lead === "t8"),
    ...row().filter((candidate) => candidate.threadId !== lead),
  ];

  it("scrolls a chip pinned to the front fully into view, smoothly", async () => {
    const offsets = place();
    const { scrollTo } = await renderChips({
      chips: row(),
      offsets,
      row: { scrollLeft: 500 },
      current: "t8",
    });
    scrollTo.mockClear();
    // t5 is pinned and leads the row; the row is scrolled far to the right.
    Object.assign(offsets, place(["t5", ...ids.filter((id) => id !== "t5")]));
    await act(async () => setHostChips(withFront("t5")));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "smooth" });
  });

  it("scrolls at once under reduced motion", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const offsets = place();
    const { scrollTo } = await renderChips({
      chips: row(),
      offsets,
      row: { scrollLeft: 500 },
      current: "t8",
    });
    scrollTo.mockClear();
    Object.assign(offsets, place(["t5", ...ids.filter((id) => id !== "t5")]));
    await act(async () => setHostChips(withFront("t5")));
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "instant" });
  });

  it("does not move the row when the pinned chip is already in view", async () => {
    const { scrollTo } = await renderChips({
      chips: row(),
      offsets: place(),
      row: { scrollLeft: 0 },
      current: "t8",
    });
    scrollTo.mockClear();
    // t1 is pinned and stays where it is: first, in view.
    await act(async () => setHostChips(row([pinned("t1")])));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("follows an unpinned chip that ends up off screen", async () => {
    const offsets = place();
    const { scrollTo } = await renderChips({
      chips: [pinned("t1"), ...row().slice(1)],
      offsets,
      row: { scrollLeft: 0 },
      current: "t8",
    });
    scrollTo.mockClear();
    // t1 is unpinned and falls back to a slot 700 px along, out of the 300 px the row shows.
    offsets["t1"] = 700;
    await act(async () => setHostChips([...row().slice(1), chip("t1")]));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ left: 700 + 80 + 24 - 300, behavior: "smooth" });
  });

  it("keeps centring the open chat when the open chat itself was pinned", async () => {
    const offsets = place();
    const { scrollTo } = await renderChips({
      chips: row(),
      offsets,
      row: { scrollLeft: 0 },
      current: "t8",
    });
    scrollTo.mockClear();
    // t8 leads the row now, at offset 3: centred, the row has no room to its left.
    offsets["t8"] = 3;
    await act(async () => setHostChips(withFront("t8")));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "smooth" });
  });

  it("a chat that is new in the row is not a pin", async () => {
    const { scrollTo } = await renderChips({
      chips: row(),
      offsets: { ...place(), t11: 3 },
      row: { scrollLeft: 500 },
      current: "t8",
    });
    scrollTo.mockClear();
    await act(async () => setHostChips([pinned("t11"), ...row()]));
    // The usual re-centre on the open chat (t8 sits 605 px along: 605 - 110), not a jump to the front.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ left: 495, behavior: "smooth" });
  });
});
