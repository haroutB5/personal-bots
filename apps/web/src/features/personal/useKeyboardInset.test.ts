import { createElement, type JSX } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useKeyboardInset } from "./useKeyboardInset";

/** Minimal visualViewport stand-in the hook can subscribe to. */
class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
}

let renderer: ReactTestRenderer | null = null;
let lastInset = -1;

function Probe(): JSX.Element | null {
  lastInset = useKeyboardInset();
  return null;
}

describe("useKeyboardInset", () => {
  const viewport = new FakeViewport();
  let scrollTo: ReturnType<typeof vi.fn>;
  let scroller: { scrollTop: number };
  let fakeWindow: {
    visualViewport: FakeViewport;
    innerHeight: number;
    scrollY: number;
    scrollTo: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    lastInset = -1;
    viewport.height = 800;
    viewport.offsetTop = 0;
    scrollTo = vi.fn();
    scroller = { scrollTop: 0 };
    fakeWindow = { visualViewport: viewport, innerHeight: 800, scrollY: 0, scrollTo };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", { scrollingElement: scroller });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  it("reports the covered height while the keyboard is open", () => {
    act(() => {
      renderer = create(createElement(Probe));
    });
    expect(lastInset).toBe(0);

    viewport.height = 500;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(300);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("restores a leftover document pan when the keyboard closes", () => {
    act(() => {
      renderer = create(createElement(Probe));
    });
    viewport.height = 500;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(300);

    // Keyboard closes but iOS left the document panned down.
    viewport.height = 800;
    fakeWindow.scrollY = 120;
    scroller.scrollTop = 120;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(0);
    expect(scroller.scrollTop).toBe(0);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("never resets scroll while the keyboard is open, even when iOS pans the viewport", () => {
    act(() => {
      renderer = create(createElement(Probe));
    });
    // Keyboard open AND iOS panned the visual viewport down: offsetTop eats
    // the height difference, so `covered` reads ~0 while typing.
    viewport.height = 500;
    viewport.offsetTop = 300;
    fakeWindow.scrollY = 300;
    scroller.scrollTop = 300;
    act(() => {
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(lastInset).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(300);
  });

  it("leaves scroll alone when the keyboard closes with no pan", () => {
    act(() => {
      renderer = create(createElement(Probe));
    });
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(0);
  });
});
