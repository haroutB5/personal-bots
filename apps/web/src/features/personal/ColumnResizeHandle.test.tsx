import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ColumnResizeHandle } from "./ColumnResizeHandle";

interface Harness {
  readonly renderer: ReactTestRenderer;
  readonly onCommit: ReturnType<typeof vi.fn>;
  readonly setProperty: ReturnType<typeof vi.fn>;
}

function renderHandle(edge: "right" | "left", value = 340, max = 480): Harness {
  const onCommit = vi.fn();
  const setProperty = vi.fn();
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ColumnResizeHandle
        label="Resize bot list"
        edge={edge}
        controls="personal-bot-list"
        value={value}
        min={280}
        maxWidth={() => max}
        defaultWidth={340}
        cssVar="--personal-sidebar-width"
        target={() => ({ style: { setProperty } }) as unknown as HTMLElement}
        measure={() => null}
        onCommit={onCommit}
      />,
    );
  });
  return { renderer: renderer!, onCommit, setProperty };
}

const separator = (harness: Harness) => harness.renderer.root.findByProps({ role: "separator" });

const press = (harness: Harness, key: string) => {
  const preventDefault = vi.fn();
  act(() => {
    separator(harness).props.onKeyDown({ key, preventDefault });
  });
  return preventDefault;
};

describe("ColumnResizeHandle", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("is a focusable vertical separator carrying the width", () => {
    const props = separator(renderHandle("right")).props;
    expect(props["aria-orientation"]).toBe("vertical");
    expect(props["aria-label"]).toBe("Resize bot list");
    expect(props["aria-controls"]).toBe("personal-bot-list");
    expect(props.tabIndex).toBe(0);
    expect([props["aria-valuemin"], props["aria-valuenow"], props["aria-valuemax"]]).toEqual([
      280, 340, 480,
    ]);
  });

  it("moves the edge 16px the way the arrow points", () => {
    const left = renderHandle("right");
    press(left, "ArrowRight");
    press(left, "ArrowLeft");
    expect(left.onCommit.mock.calls).toEqual([[356], [324]]);
    expect(left.setProperty).toHaveBeenCalledWith("--personal-sidebar-width", "356px");

    // A panel on the right grows when its left edge moves left.
    const right = renderHandle("left", 360, 560);
    press(right, "ArrowLeft");
    press(right, "ArrowRight");
    expect(right.onCommit.mock.calls).toEqual([[376], [344]]);
  });

  it("jumps to the limits on Home and End, and ignores other keys", () => {
    const harness = renderHandle("right");
    press(harness, "Home");
    press(harness, "End");
    const ignored = press(harness, "a");
    expect(harness.onCommit.mock.calls).toEqual([[280], [480]]);
    expect(ignored).not.toHaveBeenCalled();
  });

  it("never steps past what fits", () => {
    const harness = renderHandle("right", 476, 480);
    press(harness, "ArrowRight");
    expect(harness.onCommit).toHaveBeenLastCalledWith(480);
  });

  it("drags with pointer capture, writes only the CSS variable, commits once on release", () => {
    vi.stubGlobal("document", {
      documentElement: { style: { setProperty: vi.fn(), removeProperty: vi.fn() } },
    });
    const harness = renderHandle("right");
    const setPointerCapture = vi.fn();
    act(() => {
      separator(harness).props.onPointerDown({
        button: 0,
        pointerId: 7,
        clientX: 100,
        preventDefault: vi.fn(),
        currentTarget: { setPointerCapture },
      });
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    act(() => {
      separator(harness).props.onPointerMove({ pointerId: 7, clientX: 150 });
      separator(harness).props.onPointerMove({ pointerId: 7, clientX: 900 });
    });
    expect(harness.setProperty).toHaveBeenNthCalledWith(1, "--personal-sidebar-width", "390px");
    // Clamped to what fits.
    expect(harness.setProperty).toHaveBeenLastCalledWith("--personal-sidebar-width", "480px");
    expect(harness.onCommit).not.toHaveBeenCalled();
    act(() => {
      separator(harness).props.onPointerUp();
      separator(harness).props.onLostPointerCapture();
    });
    expect(harness.onCommit.mock.calls).toEqual([[480]]);
  });

  it("restores the default on double-click", () => {
    const harness = renderHandle("right", 420);
    act(() => {
      separator(harness).props.onDoubleClick();
    });
    expect(harness.onCommit).toHaveBeenCalledWith(340);
  });
});
