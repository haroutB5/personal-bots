import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { settleSwipeOffset, SwipeToDelete } from "./SwipeToDelete";

// The row element's ref: only `inside` counts as a tap within the row.
const inside = { name: "inside" };
const listeners = new Map<string, Set<(event: unknown) => void>>();
let renderers: ReactTestRenderer[] = [];

beforeEach(() => {
  listeners.clear();
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
  });
});

afterEach(async () => {
  for (const renderer of renderers) await act(async () => renderer.unmount());
  renderers = [];
  vi.unstubAllGlobals();
});

function fire(type: string, event: unknown) {
  for (const listener of listeners.get(type) ?? []) listener(event);
}

async function renderRow(onNavigate = vi.fn(), onDelete: () => Promise<unknown> = async () => {}) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <SwipeToDelete
        label="Delete Chat A"
        onDelete={onDelete}
        trailingActions={[{ label: "Archive Chat A", text: "Archive", run: () => {} }]}
      >
        <a href="/chat" onClick={onNavigate}>
          Chat A
        </a>
      </SwipeToDelete>,
      { createNodeMock: () => ({ contains: (target: unknown) => target === inside }) },
    );
  });
  renderers.push(renderer);
  const row = () =>
    renderer.root.find((node: ReactTestInstance) => typeof node.props.onPointerDown === "function");
  const offset = () => row().props.style.transform as string;
  const buttons = () => renderer.root.findAllByType("button").map((node) => node.props.children);
  const swipe = async (dx: number, dy = 0) => {
    const at = { clientX: 200, clientY: 20 };
    await act(async () => {
      row().props.onPointerDown({ pointerType: "touch", button: 0, ...at });
      row().props.onPointerMove({
        clientX: at.clientX + dx,
        clientY: at.clientY + dy,
        pointerId: 1,
        currentTarget: { setPointerCapture: () => {} },
      });
      row().props.onPointerUp();
    });
  };
  const tap = async () => {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => {
      row().props.onPointerDown({ pointerType: "touch", button: 0, clientX: 50, clientY: 20 });
      row().props.onPointerUp();
      row().props.onClickCapture(event);
      if (!event.preventDefault.mock.calls.length) onNavigate();
    });
    return event;
  };
  return { offset, buttons, swipe, tap };
}

describe("settleSwipeOffset", () => {
  it("opens fully past halfway and closes short of it", () => {
    expect(settleSwipeOffset(-50, 176, 88)).toBe(-176);
    expect(settleSwipeOffset(-30, 176, 88)).toBe(0);
    expect(settleSwipeOffset(60, 176, 88)).toBe(88);
  });
});

describe("SwipeToDelete", () => {
  it("swipes left open to Archive then Delete", async () => {
    const row = await renderRow();
    expect(row.buttons()).toEqual([]);
    await row.swipe(-120);
    expect(row.offset()).toBe("translateX(-176px)");
    expect(row.buttons()).toEqual(["Archive", "Delete"]);
  });

  it("a tap on a closed row navigates", async () => {
    const onNavigate = vi.fn();
    const row = await renderRow(onNavigate);
    const event = await row.tap();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("a tap on an open row closes it instead of navigating", async () => {
    const onNavigate = vi.fn();
    const row = await renderRow(onNavigate);
    await row.swipe(-120);
    const event = await row.tap();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(row.offset()).toBe("translateX(0px)");
  });

  it("a vertical drag scrolls and never opens the row", async () => {
    const row = await renderRow();
    await row.swipe(-10, 60);
    expect(row.offset()).toBe("translateX(0px)");
  });

  it("keeps only one row open at a time", async () => {
    const first = await renderRow();
    const second = await renderRow();
    await first.swipe(-120);
    await second.swipe(-120);
    expect(first.offset()).toBe("translateX(0px)");
    expect(second.offset()).toBe("translateX(-176px)");
  });

  it("closes on a tap elsewhere but not on a tap inside the row", async () => {
    const row = await renderRow();
    await row.swipe(-120);
    await act(async () => fire("pointerdown", { target: inside }));
    expect(row.offset()).toBe("translateX(-176px)");
    await act(async () => fire("pointerdown", { target: { name: "elsewhere" } }));
    expect(row.offset()).toBe("translateX(0px)");
    // The click that tap ends presses nothing else.
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    fire("click", click);
    expect(click.preventDefault).toHaveBeenCalled();
  });

  it("closes before an action runs, so its confirm dialog takes taps", async () => {
    // The confirm dialog is still up: onDelete has not settled.
    const row = await renderRow(vi.fn(), () => new Promise(() => {}));
    await row.swipe(-120);
    const renderer = renderers.at(-1)!;
    const deleteButton = renderer.root.findByProps({ "aria-label": "Delete Chat A" });
    await act(async () => deleteButton.props.onClick());
    expect(row.offset()).toBe("translateX(0px)");
    // A tap on the dialog's own button is not swallowed.
    await act(async () => fire("pointerdown", { target: { name: "dialog button" } }));
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    fire("click", click);
    expect(click.preventDefault).not.toHaveBeenCalled();
  });

  it("closes when the list scrolls", async () => {
    const row = await renderRow();
    await row.swipe(-120);
    await act(async () => fire("scroll", {}));
    expect(row.offset()).toBe("translateX(0px)");
  });
});
