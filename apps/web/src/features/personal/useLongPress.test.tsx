import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { LONG_PRESS_MS, type LongPressHandlers, useLongPress } from "./useLongPress";

let handlers: LongPressHandlers | null = null;
let renderer: ReactTestRenderer | null = null;

function Probe({ onLongPress }: { onLongPress: () => void }) {
  handlers = useLongPress(onLongPress);
  return null;
}

const pointer = (x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({ clientX: x, clientY: y, pointerType: "touch", button: 0, ...extra }) as never;

function mouseEvent() {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
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
  it("fires after a still hold and swallows the click that ends it", async () => {
    const onLongPress = vi.fn();
    const press = await mount(onLongPress);
    press.onPointerDown(pointer(10, 10));
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    press.onPointerUp();
    const click = mouseEvent();
    press.onClickCapture(click as never);
    expect(click.preventDefault).toHaveBeenCalled();
    expect(click.stopPropagation).toHaveBeenCalled();
    // Only that one click: the next tap opens the row as usual.
    const next = mouseEvent();
    press.onPointerDown(pointer(10, 10));
    press.onPointerUp();
    press.onClickCapture(next as never);
    expect(next.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves a short tap alone", async () => {
    const onLongPress = vi.fn();
    const press = await mount(onLongPress);
    press.onPointerDown(pointer(10, 10));
    vi.advanceTimersByTime(200);
    press.onPointerUp();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const click = mouseEvent();
    press.onClickCapture(click as never);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(click.preventDefault).not.toHaveBeenCalled();
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
    const menu = mouseEvent();
    press.onContextMenu(menu as never);
    expect(menu.preventDefault).toHaveBeenCalled();
  });
});
