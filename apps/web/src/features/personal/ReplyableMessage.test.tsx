import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearSelectionIn,
  hasSelectionIn,
  selectAllIn,
  selectWordAtPoint,
} from "./messageTextSelection";
import { ReplyableMessage } from "./ReplyableMessage";

// The DOM selection is the browser's; these tests are about when the message asks for it.
vi.mock("./messageTextSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messageTextSelection")>()),
  selectWordAtPoint: vi.fn(() => true),
  selectAllIn: vi.fn(() => true),
  hasSelectionIn: vi.fn(() => false),
  clearSelectionIn: vi.fn(),
}));

// Base UI's menu needs a DOM; what matters here is when the owner's code opens it.
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ open, children }: { open: boolean; children: ReactNode }) => (
    <div data-testid="menu-root" data-open={String(open)}>
      {children}
    </div>
  ),
  MenuTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  MenuPopup: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
}));

const QUOTE = { messageId: "m1", name: "Mori", excerpt: "All green." };
const LONG_PRESS_MS = 500;

describe("ReplyableMessage", () => {
  let renderer: ReactTestRenderer | undefined;
  const onReply = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.useFakeTimers();
    // After the fake clock is in, so the component's `window.setTimeout` is the fake one.
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    onReply.mockReset();
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = async () => {
    await act(async () => {
      renderer = create(
        <ReplyableMessage
          messageId="m1"
          quote={QUOTE}
          copyText="All green."
          onReply={onReply}
          align="start"
        >
          <p>All green.</p>
        </ReplyableMessage>,
      );
    });
    return renderer!.root;
  };
  const row = (root: Awaited<ReturnType<typeof render>>) =>
    root.findByProps({ "data-replyable": "" });
  const isOpen = (root: Awaited<ReturnType<typeof render>>) =>
    root.findByProps({ "data-testid": "menu-root" }).props["data-open"];
  const touch = (inside: boolean) => ({
    pointerType: "touch",
    clientX: 10,
    clientY: 10,
    currentTarget: { contains: () => inside },
    target: {},
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });

  it("carries the message's id for a quote's jump", async () => {
    const root = await render();
    expect(row(root).props["data-message-id"]).toBe("m1");
  });

  it("opens its menu after a finger rests on the message", async () => {
    const root = await render();
    await act(async () => row(root).props.onPointerDown(touch(true)));
    expect(isOpen(root)).toBe("false");
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(isOpen(root)).toBe("true");
  });

  it("does not open when the finger lifts or moves first (a tap or a scroll)", async () => {
    const root = await render();
    await act(async () => row(root).props.onPointerDown(touch(true)));
    await act(async () => row(root).props.onPointerUp(touch(true)));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(isOpen(root)).toBe("false");

    await act(async () => row(root).props.onPointerDown(touch(true)));
    await act(async () =>
      row(root).props.onPointerMove({ ...touch(true), clientX: 10, clientY: 60 }),
    );
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(isOpen(root)).toBe("false");
  });

  it("does not start a press from a tap on its own menu (the popup is portaled)", async () => {
    // React bubbles a portaled popup's events up to the message. Picking Reply
    // used to start a second long press that reopened the menu half a second later.
    const root = await render();
    await act(async () => row(root).props.onPointerDown(touch(false)));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(isOpen(root)).toBe("false");
  });

  it("leaves a mouse press alone, so text can still be selected", async () => {
    const root = await render();
    await act(async () => row(root).props.onPointerDown({ ...touch(true), pointerType: "mouse" }));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(isOpen(root)).toBe("false");
  });

  it("opens on a right click and gives the quote to Reply", async () => {
    const root = await render();
    const event = touch(true);
    await act(async () => row(root).props.onContextMenu(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(isOpen(root)).toBe("true");
    const reply = root
      .findAllByProps({ role: "menuitem" })
      .find((item) => item.children.includes("Reply"));
    await act(async () => reply!.props.onClick());
    expect(onReply).toHaveBeenCalledExactlyOnceWith(QUOTE);
  });

  it("ignores a context menu raised from inside the popup", async () => {
    const root = await render();
    await act(async () => row(root).props.onContextMenu(touch(false)));
    expect(isOpen(root)).toBe("false");
  });
});

describe("ReplyableMessage: select text", () => {
  let renderer: ReactTestRenderer | undefined;
  const handlers = new Map<string, (event: unknown) => void>();
  const anchorNode = { contains: (node: unknown) => node === inside };
  const inside = { name: "inside the message" };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    handlers.clear();
    vi.stubGlobal("document", {
      addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
      removeEventListener: (type: string) => handlers.delete(type),
    });
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.mocked(selectWordAtPoint).mockClear();
    vi.mocked(selectAllIn).mockClear();
    vi.mocked(clearSelectionIn).mockClear();
    vi.mocked(hasSelectionIn).mockReset().mockReturnValue(false);
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = async () => {
    await act(async () => {
      renderer = create(
        <ReplyableMessage
          messageId="m1"
          quote={QUOTE}
          copyText="All green."
          onReply={() => undefined}
          align="start"
        >
          <p>All green.</p>
        </ReplyableMessage>,
        // The refs the component reads: the row, and the wrapper of its text.
        { createNodeMock: (element) => (element.props["data-replyable"] === "" ? anchorNode : {}) },
      );
    });
    return renderer!.root;
  };
  const row = (root: Awaited<ReturnType<typeof render>>) =>
    root.findByProps({ "data-replyable": "" });
  const finger = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
    pointerType: "touch",
    clientX: x,
    clientY: y,
    currentTarget: { contains: () => true },
    target: { closest: () => null },
    ...extra,
  });
  const tap = async (root: Awaited<ReturnType<typeof render>>, x = 40, y = 60, extra = {}) => {
    await act(async () => row(root).props.onPointerDown(finger(x, y, extra)));
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    await act(async () => row(root).props.onPointerUp(finger(x, y, extra)));
  };
  const isSelecting = (root: Awaited<ReturnType<typeof render>>) =>
    row(root).props["data-selecting"] === "";
  const isOpen = (root: Awaited<ReturnType<typeof render>>) =>
    root.findByProps({ "data-testid": "menu-root" }).props["data-open"];
  const classes = (root: Awaited<ReturnType<typeof render>>) => String(row(root).props.className);

  it("is locked on a touch screen until asked, and never zooms on a double tap", async () => {
    const root = await render();
    expect(isSelecting(root)).toBe(false);
    expect(classes(root)).toContain("[@media(pointer:coarse)]:select-none");
    expect(classes(root)).toContain("[@media(pointer:coarse)]:touch-manipulation");
    expect(classes(root)).not.toContain(" select-text");
  });

  it("offers Select text in the menu, between Reply and Copy text", async () => {
    const root = await render();
    const items = root.findAllByProps({ role: "menuitem" }).map((item) => item.children.join(""));
    expect(items).toEqual(["Reply", "Select text", "Copy text"]);
  });

  it("Select text makes this one message selectable and selects all of it once the menu has closed", async () => {
    const root = await render();
    const item = root
      .findAllByProps({ role: "menuitem" })
      .find((entry) => entry.children.includes("Select text"));
    await act(async () => item!.props.onClick());
    expect(isSelecting(root)).toBe(true);
    expect(classes(root)).toContain("select-text");
    expect(classes(root)).toContain("[-webkit-touch-callout:default]");
    expect(classes(root)).not.toContain("select-none");
    expect(selectAllIn).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(selectAllIn).toHaveBeenCalledTimes(1);
    expect(selectWordAtPoint).not.toHaveBeenCalled();
  });

  it("a double tap selects the tapped word at once and turns the message selectable", async () => {
    const root = await render();
    await tap(root, 40, 60);
    expect(isSelecting(root)).toBe(false);
    await act(async () => row(root).props.onPointerDown(finger(42, 61)));
    expect(isSelecting(root)).toBe(true);
    expect(selectWordAtPoint).toHaveBeenCalledTimes(1);
    expect(vi.mocked(selectWordAtPoint).mock.calls[0]!.slice(1)).toEqual([42, 61]);
    expect(selectAllIn).not.toHaveBeenCalled();
    // The second tap is not a long press: the menu stays shut.
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(isOpen(root)).toBe("false");
  });

  it("a double tap is two quick taps on the same spot: not slow ones, moved ones or a hold", async () => {
    const root = await render();
    const settle = async () => {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    };
    await tap(root, 40, 60);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => row(root).props.onPointerDown(finger(40, 60)));
    expect(isSelecting(root)).toBe(false);
    await act(async () => row(root).props.onPointerUp(finger(40, 60)));
    await settle();

    // A first touch that slid (a scroll) is not a tap.
    await act(async () => row(root).props.onPointerDown(finger(40, 60)));
    await act(async () => row(root).props.onPointerUp(finger(40, 120)));
    await act(async () => row(root).props.onPointerDown(finger(40, 120)));
    expect(isSelecting(root)).toBe(false);
    await act(async () => row(root).props.onPointerUp(finger(40, 120)));
    await settle();

    // A first touch that rested (a long press) is not a tap either.
    await act(async () => row(root).props.onPointerDown(finger(40, 60)));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => row(root).props.onPointerUp(finger(40, 60)));
    await act(async () => row(root).props.onPointerDown(finger(40, 60)));
    expect(isSelecting(root)).toBe(false);
    expect(selectWordAtPoint).not.toHaveBeenCalled();
  });

  it("a double tap on a link, button or choice is the control's own, and a mouse never starts it", async () => {
    const root = await render();
    const onLink = { target: { closest: () => ({}) } };
    await tap(root, 40, 60, onLink);
    await act(async () => row(root).props.onPointerDown(finger(40, 60, onLink)));
    expect(isSelecting(root)).toBe(false);
    await act(async () => row(root).props.onPointerUp(finger(40, 60, onLink)));

    await tap(root, 40, 60, { pointerType: "mouse" });
    await act(async () => row(root).props.onPointerDown(finger(40, 60, { pointerType: "mouse" })));
    expect(isSelecting(root)).toBe(false);
    expect(selectWordAtPoint).not.toHaveBeenCalled();
  });

  it("a tap from inside the message's own popup is not a tap on the message", async () => {
    const root = await render();
    const popup = { currentTarget: { contains: () => false } };
    await tap(root, 40, 60, popup);
    await act(async () => row(root).props.onPointerDown(finger(40, 60, popup)));
    expect(isSelecting(root)).toBe(false);
  });

  it("while selecting, a hold is the browser's own and does not open the Reply menu", async () => {
    const root = await render();
    await tap(root, 40, 60);
    await act(async () => row(root).props.onPointerDown(finger(40, 60)));
    expect(isSelecting(root)).toBe(true);
    await act(async () => row(root).props.onPointerUp(finger(40, 60)));
    await act(async () => row(root).props.onPointerDown(finger(100, 200)));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(isOpen(root)).toBe("false");
  });

  const startSelecting = async (root: Awaited<ReturnType<typeof render>>) => {
    await tap(root, 40, 60);
    await act(async () => row(root).props.onPointerDown(finger(40, 60)));
    await act(async () => row(root).props.onPointerUp(finger(40, 60)));
    expect(isSelecting(root)).toBe(true);
  };

  it("ends when the selection is cleared, after it had one", async () => {
    const root = await render();
    await startSelecting(root);
    // Nothing selected yet and a change comes in (the browser settling): still selecting.
    await act(async () => handlers.get("selectionchange")!({}));
    expect(isSelecting(root)).toBe(true);
    vi.mocked(hasSelectionIn).mockReturnValue(true);
    await act(async () => handlers.get("selectionchange")!({}));
    expect(isSelecting(root)).toBe(true);
    vi.mocked(hasSelectionIn).mockReturnValue(false);
    await act(async () => handlers.get("selectionchange")!({}));
    expect(isSelecting(root)).toBe(false);
    expect(clearSelectionIn).toHaveBeenCalled();
    expect(classes(root)).toContain("[@media(pointer:coarse)]:select-none");
    // The listeners are gone with the mode.
    expect(handlers.has("selectionchange")).toBe(false);
    expect(handlers.has("pointerdown")).toBe(false);
  });

  it("a word already selected by the double tap counts as a selection to be cleared", async () => {
    vi.mocked(hasSelectionIn).mockReturnValue(true);
    const root = await render();
    await startSelecting(root);
    vi.mocked(hasSelectionIn).mockReturnValue(false);
    await act(async () => handlers.get("selectionchange")!({}));
    expect(isSelecting(root)).toBe(false);
  });

  it("ends on a tap elsewhere, but not on a tap inside the message", async () => {
    const root = await render();
    await startSelecting(root);
    await act(async () => handlers.get("pointerdown")!({ target: inside }));
    expect(isSelecting(root)).toBe(true);
    await act(async () => handlers.get("pointerdown")!({ target: { name: "another message" } }));
    expect(isSelecting(root)).toBe(false);
  });

  it("ends when the message scrolls out of view", async () => {
    const seen: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    class FakeObserver {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        seen.push(callback);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const root = await render();
    await startSelecting(root);
    expect(seen).toHaveLength(1);
    await act(async () => seen[0]!([{ isIntersecting: true }]));
    expect(isSelecting(root)).toBe(true);
    await act(async () => seen[0]!([{ isIntersecting: false }]));
    expect(isSelecting(root)).toBe(false);
  });

  it("long press still opens the menu on a message that is not being selected", async () => {
    const root = await render();
    await act(async () => row(root).props.onPointerDown(finger(40, 60)));
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(isOpen(root)).toBe("true");
    expect(isSelecting(root)).toBe(false);
  });
});
