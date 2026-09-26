import { createElement, type JSX, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useKeyboardInset } from "./useKeyboardInset";

/** Minimal visualViewport stand-in the hook can subscribe to. */
class FakeViewport extends EventTarget {
  height = 873;
  offsetTop = 0;
}

/** Just enough of an element for the hook's typable-focus check. */
const COMPOSER = { tagName: "TEXTAREA" };
const SEND_BUTTON = { tagName: "BUTTON" };

let renderer: ReactTestRenderer | null = null;
let lastInset = -1;

function makeShell(bottom: number): RefObject<HTMLElement | null> {
  return {
    current: {
      getBoundingClientRect: () => ({ bottom }),
    } as unknown as HTMLElement,
  };
}

function probeWith(shell: RefObject<HTMLElement | null>) {
  function Probe(): JSX.Element | null {
    lastInset = useKeyboardInset(shell);
    return null;
  }
  return Probe;
}

/** `focusout` carries the element focus is moving to; the hook reads it. */
function focusOutEvent(relatedTarget: unknown): Event {
  return Object.assign(new Event("focusout"), { relatedTarget });
}

function delegate(target: EventTarget) {
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
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
    dispatchEvent: (event: Event) => boolean;
  };
  let fakeDocument: {
    scrollingElement: { scrollTop: number };
    activeElement: unknown;
    dispatchEvent: (event: Event) => boolean;
  };
  let frames: Array<FrameRequestCallback | undefined>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    lastInset = -1;
    viewport.height = 873;
    viewport.offsetTop = 0;
    scrollTo = vi.fn();
    scroller = { scrollTop: 0 };
    fakeWindow = {
      visualViewport: viewport,
      innerHeight: 873,
      scrollY: 0,
      scrollTo,
      ...delegate(new EventTarget()),
    };
    fakeDocument = {
      scrollingElement: scroller,
      // Every geometry case below is "the keyboard is up", which on a phone
      // always means a typable element holds focus.
      activeElement: COMPOSER,
      ...delegate(new EventTarget()),
    };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      frames[handle - 1] = undefined;
    });
  });

  /** The collapse is deferred a frame, so the tests drive the frame by hand. */
  function flushFrames() {
    const pending = frames;
    frames = [];
    act(() => {
      for (const frame of pending) frame?.(0);
    });
  }

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  it("pads by the shell overlap when iOS resizes the layout viewport but not dvh", () => {
    // Measured device behavior: innerHeight follows the keyboard (487) while
    // the 100dvh shell stays 873 tall, so innerHeight-based math reads 0.
    const shell = makeShell(873);
    act(() => {
      renderer = create(createElement(probeWith(shell)));
    });
    expect(lastInset).toBe(0);

    fakeWindow.innerHeight = 487;
    viewport.height = 487;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(386);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("pads by the visible overlap when only the visual viewport shrinks (older iOS, with pan)", () => {
    const shell = makeShell(873);
    act(() => {
      renderer = create(createElement(probeWith(shell)));
    });
    viewport.height = 500;
    viewport.offsetTop = 300;
    fakeWindow.scrollY = 300;
    scroller.scrollTop = 300;
    act(() => {
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(lastInset).toBe(73);
    // Keyboard is open: never reset the pan mid-typing.
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(300);
  });

  it("adds no padding when the shell itself shrinks with the keyboard (Chromium)", () => {
    const shell = makeShell(487);
    act(() => {
      renderer = create(createElement(probeWith(shell)));
    });
    viewport.height = 487;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(0);
  });

  it("restores a leftover document pan once the shell is fully visible again", () => {
    const shell = makeShell(873);
    act(() => {
      renderer = create(createElement(probeWith(shell)));
    });
    viewport.height = 500;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(373);

    viewport.height = 873;
    fakeWindow.scrollY = 120;
    scroller.scrollTop = 120;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(0);
    expect(scroller.scrollTop).toBe(0);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("falls back to innerHeight without a shell ref", () => {
    function Probe(): JSX.Element | null {
      lastInset = useKeyboardInset();
      return null;
    }
    act(() => {
      renderer = create(createElement(Probe));
    });
    viewport.height = 500;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(373);
  });

  it("lifts a fixed sheet by the fixed edge's overlap when innerHeight follows the keyboard", () => {
    // 26 Sep, iPhone PWA: the keyboard shrinks innerHeight (873 -> 487) but
    // not the edge fixed boxes sit on, so Rename chat's sheet read an overlap
    // of 0 and stayed behind the keyboard with its text field.
    const probe = {
      style: { cssText: "" },
      setAttribute: vi.fn(),
      getBoundingClientRect: () => ({ bottom: 873 }),
      remove: vi.fn(),
    };
    const append = vi.fn();
    Object.assign(fakeDocument, { body: { append }, createElement: () => probe });
    function Probe(): JSX.Element | null {
      lastInset = useKeyboardInset();
      return null;
    }
    act(() => {
      renderer = create(createElement(Probe));
    });
    expect(append).toHaveBeenCalledWith(probe);
    expect(probe.style.cssText).toContain("position:fixed");
    expect(probe.style.cssText).toContain("bottom:0");

    fakeWindow.innerHeight = 487;
    viewport.height = 487;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(386);

    act(() => renderer?.unmount());
    renderer = null;
    expect(probe.remove).toHaveBeenCalledOnce();
  });

  it("clears the inset on blur even when the closing resize was swallowed", () => {
    // The reported bug: iOS delivers one coalesced resize part-way through the
    // dismiss animation and nothing after it, so the geometry never returns to
    // zero and the composer stays stranded mid-screen.
    const shell = makeShell(873);
    act(() => {
      renderer = create(createElement(probeWith(shell)));
    });
    viewport.height = 487;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(386);

    // Keyboard dismissed: the field blurs, the geometry still reads mid-animation.
    viewport.height = 700;
    fakeDocument.activeElement = null;
    act(() => {
      fakeDocument.dispatchEvent(focusOutEvent(null));
    });
    flushFrames();
    expect(lastInset).toBe(0);
  });

  it("holds the inset for a frame so a tap on Send is not dropped", () => {
    // The regression this guards: iOS blurs the field part-way through a tap on
    // a composer button, before the click dispatches. Collapsing the inset
    // there moves the composer out from under the finger, the click misses, and
    // the press does nothing but dismiss the keyboard. Send needed two taps.
    const shell = makeShell(873);
    act(() => {
      renderer = create(createElement(probeWith(shell)));
    });
    viewport.height = 487;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(386);

    fakeDocument.activeElement = SEND_BUTTON;
    act(() => {
      fakeDocument.dispatchEvent(focusOutEvent(SEND_BUTTON));
    });
    // Still lifted: the click has not been dispatched yet.
    expect(lastInset).toBe(386);

    flushFrames();
    expect(lastInset).toBe(0);
  });

  it("abandons the collapse when the field takes focus straight back", () => {
    const shell = makeShell(873);
    act(() => {
      renderer = create(createElement(probeWith(shell)));
    });
    viewport.height = 487;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });

    fakeDocument.activeElement = SEND_BUTTON;
    act(() => {
      fakeDocument.dispatchEvent(focusOutEvent(SEND_BUTTON));
    });
    // The button handed focus straight back to the message field.
    fakeDocument.activeElement = COMPOSER;
    act(() => {
      fakeDocument.dispatchEvent(new Event("focusin"));
    });
    flushFrames();

    expect(lastInset).toBe(386);
  });

  it("keeps the inset while focus hands off between two fields", () => {
    const shell = makeShell(873);
    act(() => {
      renderer = create(createElement(probeWith(shell)));
    });
    viewport.height = 487;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(386);

    act(() => {
      fakeDocument.dispatchEvent(focusOutEvent({ tagName: "INPUT", type: "text" }));
    });
    expect(lastInset).toBe(386);
  });

  it("clears the inset when focus moves to a button", () => {
    const shell = makeShell(873);
    act(() => {
      renderer = create(createElement(probeWith(shell)));
    });
    viewport.height = 487;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(386);

    fakeDocument.activeElement = SEND_BUTTON;
    act(() => {
      fakeDocument.dispatchEvent(focusOutEvent(SEND_BUTTON));
    });
    flushFrames();
    expect(lastInset).toBe(0);
  });

  it("recovers on a window resize when the visual viewport event is missed", () => {
    const shell = makeShell(873);
    act(() => {
      renderer = create(createElement(probeWith(shell)));
    });
    viewport.height = 487;
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(386);

    // Layout viewport restored; only `window` reports it this time.
    fakeWindow.innerHeight = 873;
    viewport.height = 873;
    act(() => {
      fakeWindow.dispatchEvent(new Event("resize"));
    });
    expect(lastInset).toBe(0);
  });

  it("re-measures when a field is focused", () => {
    const shell = makeShell(873);
    fakeDocument.activeElement = SEND_BUTTON;
    act(() => {
      renderer = create(createElement(probeWith(shell)));
    });
    expect(lastInset).toBe(0);

    viewport.height = 487;
    fakeDocument.activeElement = COMPOSER;
    act(() => {
      fakeDocument.dispatchEvent(new Event("focusin"));
    });
    expect(lastInset).toBe(386);
  });
});
