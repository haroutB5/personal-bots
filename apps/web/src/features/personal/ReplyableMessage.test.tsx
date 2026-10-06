import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ReplyableMessage } from "./ReplyableMessage";

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
    await act(async () => row(root).props.onPointerUp());
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
