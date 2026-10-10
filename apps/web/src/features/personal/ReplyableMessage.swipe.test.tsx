import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SWIPE_RELEASE_MS } from "./messageSwipe";
import { ReplyableMessage } from "./ReplyableMessage";
import { SWIPE_TIME_OPACITY_VAR } from "./useMessageSwipe";

// The DOM selection is the browser's; these tests are about when the message asks for it.
vi.mock("./messageTextSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messageTextSelection")>()),
  selectWordAtPoint: vi.fn(() => true),
  selectAllIn: vi.fn(() => true),
  hasSelectionIn: vi.fn(() => false),
  clearSelectionIn: vi.fn(),
}));

// Base UI's menu needs a DOM; what matters here is what the owner's code does.
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
const SENT_AT = new Date("2026-10-09T13:32:00Z");

/** The row as the browser would give it: a style the swipe writes, a box and pointer capture. */
function fakeRow() {
  const props = new Map<string, string>();
  return {
    props,
    contains: () => true,
    setPointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ top: 100, height: 200 }),
    style: {
      transform: "",
      transition: "",
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => void props.delete(name),
    },
  };
}

describe("ReplyableMessage: swipe to see when it was sent", () => {
  let renderer: ReactTestRenderer | undefined;
  let node = fakeRow();
  let reduceMotion = false;
  const onReply = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.useFakeTimers();
    reduceMotion = false;
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      matchMedia: () => ({ matches: reduceMotion }),
    });
    node = fakeRow();
    onReply.mockReset();
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = async (props: { align?: "start" | "end"; sentAt?: Date | null } = {}) => {
    await act(async () => {
      renderer = create(
        <ReplyableMessage
          messageId="m1"
          quote={QUOTE}
          copyText="All green."
          onReply={onReply}
          align={props.align ?? "end"}
          sentAt={props.sentAt === undefined ? SENT_AT : props.sentAt}
        >
          <p>All green.</p>
        </ReplyableMessage>,
        {
          createNodeMock: (element) =>
            (element.props as Record<string, unknown>)["data-replyable"] === "" ? node : {},
        },
      );
    });
    return renderer!.root;
  };
  type Root = Awaited<ReturnType<typeof render>>;
  const row = (root: Root) => root.findByProps({ "data-replyable": "" });
  const label = (root: Root) => root.findAllByProps({ "data-message-time": "" });
  const isOpen = (root: Root) =>
    root.findByProps({ "data-testid": "menu-root" }).props["data-open"];
  const classes = (root: Root) => String(row(root).props.className);
  const finger = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
    pointerType: "touch",
    pointerId: 7,
    isPrimary: true,
    clientX: x,
    clientY: y,
    currentTarget: node,
    target: { closest: () => null },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...extra,
  });
  const down = (root: Root, x: number, y: number, extra = {}) =>
    act(async () => row(root).props.onPointerDown(finger(x, y, extra)));
  const move = (root: Root, x: number, y: number, extra = {}) =>
    act(async () => row(root).props.onPointerMove(finger(x, y, extra)));
  const up = (root: Root, x: number, y: number) =>
    act(async () => row(root).props.onPointerUp(finger(x, y)));
  const shifted = () => Number(/translate3d\((-?[\d.]+)px/.exec(node.style.transform)?.[1] ?? 0);

  it("follows a left swipe on the owner's message and shows the time beside it", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 150);
    await move(root, 290, 150);
    // Just locked: drawn, but still invisible.
    expect(Number(node.props.get(SWIPE_TIME_OPACITY_VAR))).toBe(0);
    await move(root, 250, 150);
    expect(shifted()).toBeLessThan(0);
    expect(shifted()).toBeGreaterThan(-68);
    expect(node.style.transition).toBe("none");
    expect(node.setPointerCapture).toHaveBeenCalledWith(7);
    const [time] = label(root);
    expect(time).toBeDefined();
    // Held at the right of the message, where it moved away from.
    expect(String(time!.props.className)).toContain("left-full");
    expect(Number(node.props.get(SWIPE_TIME_OPACITY_VAR))).toBeGreaterThan(0);
  });

  it("follows a right swipe on a bot's reply and shows the time on its left", async () => {
    const root = await render({ align: "start" });
    await down(root, 100, 150);
    await move(root, 160, 150);
    expect(shifted()).toBeGreaterThan(0);
    const [time] = label(root);
    expect(String(time!.props.className)).toContain("right-full");
  });

  it("holds back as the finger goes on: resistance, never past the cap", async () => {
    const root = await render({ align: "end" });
    await down(root, 380, 150);
    await move(root, 320, 150);
    const near = shifted();
    await move(root, 40, 150);
    expect(shifted()).toBeLessThan(near);
    expect(shifted()).toBeGreaterThan(-68);
    expect(shifted()).toBeLessThan(-60);
  });

  it("writes the time of the message: today's is just the clock", async () => {
    const root = await render({ align: "end", sentAt: new Date() });
    await down(root, 300, 150);
    await move(root, 250, 150);
    const [time] = label(root);
    expect(time!.children).toHaveLength(1);
  });

  it("puts the time level with the finger, kept inside the message", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 190);
    await move(root, 250, 190);
    // Box top 100, finger at 190.
    expect(label(root)[0]!.props.style.top).toBe(90);
    await up(root, 250, 190);
    await act(async () => {
      vi.advanceTimersByTime(SWIPE_RELEASE_MS + 100);
    });
    await down(root, 300, 105);
    await move(root, 250, 105);
    expect(label(root)[0]!.props.style.top).toBe(15);
  });

  it("springs back on release, fades the time out and cleans up", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 150);
    await move(root, 240, 150);
    await up(root, 240, 150);
    expect(node.style.transition).toContain("transform");
    expect(node.style.transition).not.toBe("none");
    expect(node.style.transform).toBe("translate3d(0, 0, 0)");
    expect(node.props.get(SWIPE_TIME_OPACITY_VAR)).toBe("0");
    // The time is still drawn while it fades.
    expect(label(root)).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(SWIPE_RELEASE_MS + 40);
    });
    expect(node.style.transform).toBe("");
    expect(node.style.transition).toBe("");
    expect(node.props.has(SWIPE_TIME_OPACITY_VAR)).toBe(false);
    expect(label(root)).toHaveLength(0);
  });

  it("with reduced motion, nothing eases: it lets go at once", async () => {
    reduceMotion = true;
    const root = await render({ align: "end" });
    await down(root, 300, 150);
    await move(root, 240, 150);
    expect(label(root)).toHaveLength(1);
    await up(root, 240, 150);
    expect(node.style.transition).toBe("");
    expect(node.style.transform).toBe("");
    expect(label(root)).toHaveLength(0);
  });

  it("ignores a swipe the wrong way", async () => {
    const owner = await render({ align: "end" });
    await down(owner, 100, 150);
    await move(owner, 200, 150);
    expect(node.style.transform).toBe("");
    expect(label(owner)).toHaveLength(0);
    // And a later move back the right way does not pick the gesture up.
    await move(owner, 20, 150);
    expect(node.style.transform).toBe("");
    await up(owner, 20, 150);
    await act(async () => renderer?.unmount());

    node = fakeRow();
    const bot = await render({ align: "start" });
    await down(bot, 300, 150);
    await move(bot, 200, 150);
    expect(node.style.transform).toBe("");
    expect(label(bot)).toHaveLength(0);
  });

  it("leaves a mostly vertical move to the scroll, even if it drifts sideways later", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 150);
    await move(root, 295, 200);
    await move(root, 150, 230);
    expect(node.style.transform).toBe("");
    expect(label(root)).toHaveLength(0);
    expect(node.setPointerCapture).not.toHaveBeenCalled();
  });

  it("does not take a touch that starts in the edge swipe back's strip", async () => {
    const root = await render({ align: "start" });
    await down(root, 8, 150);
    await move(root, 90, 150);
    expect(node.style.transform).toBe("");
    expect(label(root)).toHaveLength(0);
  });

  it("is off for a mouse, a second finger and a touch from the menu's own popup", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 150, { pointerType: "mouse" });
    await move(root, 200, 150, { pointerType: "mouse" });
    expect(node.style.transform).toBe("");
    await down(root, 300, 150, { isPrimary: false });
    await move(root, 200, 150);
    expect(node.style.transform).toBe("");
    await down(root, 300, 150, { currentTarget: { contains: () => false } });
    await move(root, 200, 150);
    expect(node.style.transform).toBe("");
    expect(label(root)).toHaveLength(0);
  });

  it("has no swipe for a message with no send time", async () => {
    const root = await render({ align: "end", sentAt: null });
    await down(root, 300, 150);
    await move(root, 200, 150);
    expect(node.style.transform).toBe("");
    expect(label(root)).toHaveLength(0);
    expect(classes(root)).not.toContain("pan-y");
    expect(classes(root)).toContain("touch-manipulation");
  });

  it("scrolls up and down natively and never zooms on a double tap", async () => {
    const root = await render({ align: "end" });
    expect(classes(root)).toContain("[@media(pointer:coarse)]:[touch-action:pan-y_pinch-zoom]");
    expect(classes(root)).not.toContain("touch-manipulation");
  });

  it("a swipe takes the touch from the long press", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 150);
    await move(root, 260, 150);
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(isOpen(root)).toBe("false");
  });

  it("a long press still opens the menu, and no swipe starts once it is open", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 150);
    await act(async () => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(isOpen(root)).toBe("true");
    await move(root, 200, 150);
    expect(node.style.transform).toBe("");
    expect(label(root)).toHaveLength(0);
  });

  it("is off while the text is being selected", async () => {
    const root = await render({ align: "end" });
    const select = root
      .findAllByProps({ role: "menuitem" })
      .find((item) => item.children.includes("Select text"));
    await act(async () => select!.props.onClick());
    expect(row(root).props["data-selecting"]).toBe("");
    expect(classes(root)).toContain("touch-manipulation");
    await down(root, 300, 150);
    await move(root, 200, 150);
    expect(node.style.transform).toBe("");
    expect(label(root)).toHaveLength(0);
  });

  it("stops following if the text is being selected mid-gesture", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 150);
    await move(root, 250, 150);
    expect(label(root)).toHaveLength(1);
    const select = root
      .findAllByProps({ role: "menuitem" })
      .find((item) => item.children.includes("Select text"));
    await act(async () => select!.props.onClick());
    await move(root, 200, 150);
    expect(node.style.transition).toContain("transform");
    expect(node.style.transform).toBe("translate3d(0, 0, 0)");
  });

  it("swallows the click that ends a swipe, once, and not an ordinary tap", async () => {
    const root = await render({ align: "end" });
    const click = () => ({
      currentTarget: { contains: () => true },
      target: {},
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    const tapClick = click();
    row(root).props.onClickCapture(tapClick);
    expect(tapClick.preventDefault).not.toHaveBeenCalled();

    await down(root, 300, 150);
    await move(root, 240, 150);
    await up(root, 240, 150);
    const swipeClick = click();
    row(root).props.onClickCapture(swipeClick);
    expect(swipeClick.preventDefault).toHaveBeenCalledTimes(1);
    expect(swipeClick.stopPropagation).toHaveBeenCalledTimes(1);
    const next = click();
    row(root).props.onClickCapture(next);
    expect(next.preventDefault).not.toHaveBeenCalled();
  });

  it("stops swallowing clicks once the click that ends a swipe could no longer come", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 150);
    await move(root, 240, 150);
    await up(root, 240, 150);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    const click = {
      currentTarget: { contains: () => true },
      target: {},
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    row(root).props.onClickCapture(click);
    expect(click.preventDefault).not.toHaveBeenCalled();
  });

  it("a cancelled touch (the browser took it to scroll) springs back like a release", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 150);
    await move(root, 240, 150);
    await act(async () => row(root).props.onPointerCancel());
    expect(node.style.transform).toBe("translate3d(0, 0, 0)");
    await act(async () => {
      vi.advanceTimersByTime(SWIPE_RELEASE_MS + 40);
    });
    expect(label(root)).toHaveLength(0);
  });

  it("an earlier swipe cannot clear the next swipe's click guard", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 150);
    await move(root, 240, 150);
    await up(root, 240, 150);
    await act(async () => vi.advanceTimersByTime(200));
    await down(root, 300, 150);
    await move(root, 240, 150);
    await act(async () => vi.advanceTimersByTime(151));
    await up(root, 240, 150);
    const click = {
      currentTarget: { contains: () => true },
      target: {},
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    row(root).props.onClickCapture(click);
    expect(click.preventDefault).toHaveBeenCalledTimes(1);
    expect(click.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("a new touch during the spring back starts clean", async () => {
    const root = await render({ align: "end" });
    await down(root, 300, 150);
    await move(root, 240, 150);
    await up(root, 240, 150);
    await down(root, 300, 150);
    expect(node.style.transform).toBe("");
    expect(node.style.transition).toBe("");
    await move(root, 250, 150);
    expect(shifted()).toBeLessThan(0);
  });
});
