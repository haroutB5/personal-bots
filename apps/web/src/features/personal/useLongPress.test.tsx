import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { LONG_PRESS_MS, type LongPressHandlers, useLongPress } from "./useLongPress";

let handlers: LongPressHandlers | null = null;
let renderer: ReactTestRenderer | null = null;
const listeners = new Map<string, Set<(event: unknown) => void>>();

function Probe({ onLongPress }: { onLongPress: () => void }) {
  handlers = useLongPress(onLongPress);
  return null;
}

const pointer = (x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({ clientX: x, clientY: y, pointerType: "touch", button: 0, ...extra }) as never;

/** Dispatches to the document listeners; true when something swallowed the event. */
function fire(type: string): boolean {
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
  for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  return event.preventDefault.mock.calls.length > 0;
}

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  vi.stubGlobal("window", globalThis);
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
  if (renderer !== null) await act(async () => renderer!.unmount());
  renderer = null;
  handlers = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(onLongPress: () => void) {
  await act(async () => {
    renderer = create(<Probe onLongPress={onLongPress} />);
  });
  return handlers!;
}

describe("useLongPress", () => {
  it("fires after a still hold and swallows the click that ends it, wherever it lands", async () => {
    const onLongPress = vi.fn();
    const press = await mount(onLongPress);
    press.onPointerDown(pointer(10, 10));
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    // Held on: a click now (the list re-laid out under the finger) is eaten.
    vi.advanceTimersByTime(1000);
    fire("pointerup");
    expect(fire("click")).toBe(true);
    // Shortly after the lift the guard is gone: the next tap works as usual.
    vi.advanceTimersByTime(400);
    expect(fire("click")).toBe(false);
  });

  it("stops guarding soon after the lift when no click comes (iOS after a hold)", async () => {
    const press = await mount(vi.fn());
    press.onPointerDown(pointer(10, 10));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fire("pointercancel");
    vi.advanceTimersByTime(400);
    expect(fire("click")).toBe(false);
  });

  it("leaves a short tap alone", async () => {
    const onLongPress = vi.fn();
    const press = await mount(onLongPress);
    press.onPointerDown(pointer(10, 10));
    vi.advanceTimersByTime(200);
    press.onPointerUp();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(fire("click")).toBe(false);
  });

  it("gives way to a swipe or a scroll by the swipe row's own 8 px lock", async () => {
    const onLongPress = vi.fn();
    const press = await mount(onLongPress);
    press.onPointerDown(pointer(10, 10));
    press.onPointerMove(pointer(18, 10));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();

    press.onPointerDown(pointer(10, 10));
    press.onPointerCancel();
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("tolerates a finger's small wobble", async () => {
    const onLongPress = vi.fn();
    const press = await mount(onLongPress);
    press.onPointerDown(pointer(10, 10));
    press.onPointerMove(pointer(14, 13));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("ignores a right click but keeps the context menu off the row", async () => {
    const onLongPress = vi.fn();
    const press = await mount(onLongPress);
    press.onPointerDown(pointer(10, 10, { pointerType: "mouse", button: 2 }));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
    const menu = { preventDefault: vi.fn() };
    press.onContextMenu(menu as never);
    expect(menu.preventDefault).toHaveBeenCalled();
  });
});
