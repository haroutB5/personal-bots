import { describe, expect, it, vi } from "vite-plus/test";

import {
  clearSelectionIn,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  hasSelectionIn,
  isDoubleTap,
  selectAllIn,
  selectWordAtPoint,
  wordBoundsAt,
  type SelectionDocument,
} from "./messageTextSelection";

describe("isDoubleTap", () => {
  const first = { t: 1000, x: 100, y: 200 };

  it("is a second tap soon after the first, on the same spot", () => {
    expect(isDoubleTap(first, { t: 1000 + 150, x: 104, y: 198 })).toBe(true);
    expect(isDoubleTap(first, { t: 1000 + DOUBLE_TAP_MS, x: 100, y: 200 })).toBe(true);
  });

  it("is not when there was no first tap, it was too long ago, or the finger landed elsewhere", () => {
    expect(isDoubleTap(null, { t: 1100, x: 100, y: 200 })).toBe(false);
    expect(isDoubleTap(first, { t: 1000 + DOUBLE_TAP_MS + 1, x: 100, y: 200 })).toBe(false);
    expect(isDoubleTap(first, { t: 1100, x: 100 + DOUBLE_TAP_SLOP_PX + 1, y: 200 })).toBe(false);
    expect(isDoubleTap(first, { t: 1100, x: 100, y: 200 - DOUBLE_TAP_SLOP_PX - 1 })).toBe(false);
    expect(isDoubleTap(first, { t: 900, x: 100, y: 200 })).toBe(false);
  });
});

describe("wordBoundsAt", () => {
  const word = (text: string, offset: number) => {
    const bounds = wordBoundsAt(text, offset);
    return bounds === null ? null : text.slice(bounds.start, bounds.end);
  };

  it("finds the word the caret is in, at either edge or inside", () => {
    const text = "All checks are green.";
    expect(word(text, 0)).toBe("All");
    expect(word(text, 5)).toBe("checks");
    expect(word(text, 10)).toBe("checks");
    expect(word(text, 16)).toBe("green");
    expect(word(text, 20)).toBe("green");
  });

  it("keeps contractions, hyphenated words and decimals whole, and leaves the full stop out", () => {
    expect(word("it doesn’t work", 6)).toBe("doesn’t");
    expect(word("it doesn't work", 6)).toBe("doesn't");
    expect(word("a well-known fix", 5)).toBe("well-known");
    expect(word("version 1.65.1 is live", 10)).toBe("1.65.1");
    expect(word("the end.", 6)).toBe("end");
    expect(word("'quoted'", 3)).toBe("quoted");
  });

  it("works on any alphabet and on digits", () => {
    expect(word("héllo wörld", 8)).toBe("wörld");
    expect(word("привет мир", 2)).toBe("привет");
    expect(word("room 404 now", 6)).toBe("404");
  });

  it("is null between words, on punctuation alone and on empty text", () => {
    expect(wordBoundsAt("a  b", 2)).toBeNull();
    expect(wordBoundsAt("...", 1)).toBeNull();
    expect(wordBoundsAt("", 0)).toBeNull();
    expect(wordBoundsAt("word", 99)?.end).toBe(4);
  });
});

/** A minimal DOM: a text node inside a root, and a selection that records what was set. */
function fakeDom(text: string) {
  const textNode = { nodeType: 3, textContent: text } as unknown as Node;
  const outside = { nodeType: 3, textContent: "elsewhere" } as unknown as Node;
  const root = { contains: (node: Node | null) => node === textNode } as unknown as Node;
  const ranges: Array<{ start?: [Node, number]; end?: [Node, number]; all?: Node }> = [];
  const state = { current: null as null | (typeof ranges)[number], collapsed: true };
  const selection = {
    get rangeCount() {
      return state.current === null ? 0 : 1;
    },
    get isCollapsed() {
      return state.current === null || state.collapsed;
    },
    get anchorNode() {
      return state.current?.start?.[0] ?? state.current?.all ?? null;
    },
    get focusNode() {
      return state.current?.end?.[0] ?? state.current?.all ?? null;
    },
    removeAllRanges: vi.fn(() => {
      state.current = null;
    }),
    addRange: vi.fn((range: (typeof ranges)[number]) => {
      state.current = range;
      state.collapsed = false;
    }),
  } as unknown as Selection;
  const doc: SelectionDocument = {
    getSelection: () => selection,
    createRange: () => {
      const range: (typeof ranges)[number] = {};
      Object.assign(range, {
        setStart: (node: Node, offset: number) => {
          range.start = [node, offset];
        },
        setEnd: (node: Node, offset: number) => {
          range.end = [node, offset];
        },
        selectNodeContents: (node: Node) => {
          range.all = node;
        },
      });
      return range as unknown as Range;
    },
    caretPositionFromPoint: undefined,
    caretRangeFromPoint: undefined,
  };
  return { doc, root, textNode, outside, selection, state };
}

describe("selectWordAtPoint", () => {
  it("selects the word under the finger from the caret position (Firefox, Safari 17.4+)", () => {
    const dom = fakeDom("All checks are green.");
    const doc = {
      ...dom.doc,
      caretPositionFromPoint: () => ({ offsetNode: dom.textNode, offset: 6 }),
    };
    expect(selectWordAtPoint(dom.root, 50, 60, doc)).toBe(true);
    expect(dom.state.current).toMatchObject({ start: [dom.textNode, 4], end: [dom.textNode, 10] });
  });

  it("falls back to the caret range (older WebKit and Chrome)", () => {
    const dom = fakeDom("All checks are green.");
    const doc = {
      ...dom.doc,
      caretRangeFromPoint: () =>
        ({ startContainer: dom.textNode, startOffset: 12 }) as unknown as Range,
    };
    expect(selectWordAtPoint(dom.root, 50, 60, doc)).toBe(true);
    expect(dom.state.current).toMatchObject({ start: [dom.textNode, 11], end: [dom.textNode, 14] });
  });

  it("selects nothing on a space, outside the message, or when the browser has no caret lookup", () => {
    const dom = fakeDom("one  two");
    expect(
      selectWordAtPoint(dom.root, 1, 1, {
        ...dom.doc,
        caretPositionFromPoint: () => ({ offsetNode: dom.textNode, offset: 4 }),
      }),
    ).toBe(false);
    expect(
      selectWordAtPoint(dom.root, 1, 1, {
        ...dom.doc,
        caretPositionFromPoint: () => ({ offsetNode: dom.outside, offset: 2 }),
      }),
    ).toBe(false);
    expect(selectWordAtPoint(dom.root, 1, 1, dom.doc)).toBe(false);
    expect(dom.selection.addRange).not.toHaveBeenCalled();
  });
});

describe("selectAllIn, hasSelectionIn and clearSelectionIn", () => {
  it("selects the whole message, sees it, and clears only a selection inside it", () => {
    const dom = fakeDom("hello there");
    expect(hasSelectionIn(dom.root, dom.doc)).toBe(false);
    expect(selectAllIn(dom.root, dom.doc)).toBe(true);
    expect(dom.state.current).toMatchObject({ all: dom.root });
    // The fake's anchor is the root itself here, which it does not contain: model a real one.
    dom.state.current = { start: [dom.textNode, 0], end: [dom.textNode, 5] };
    expect(hasSelectionIn(dom.root, dom.doc)).toBe(true);
    clearSelectionIn(dom.root, dom.doc);
    expect(dom.state.current).toBeNull();

    dom.state.current = { start: [dom.outside, 0], end: [dom.outside, 3] };
    dom.state.collapsed = false;
    expect(hasSelectionIn(dom.root, dom.doc)).toBe(false);
    clearSelectionIn(dom.root, dom.doc);
    expect(dom.state.current).not.toBeNull();
  });

  it("treats a collapsed selection as none", () => {
    const dom = fakeDom("hello");
    dom.state.current = { start: [dom.textNode, 2], end: [dom.textNode, 2] };
    dom.state.collapsed = true;
    expect(hasSelectionIn(dom.root, dom.doc)).toBe(false);
  });

  it("gives up quietly when the browser has no selection", () => {
    const dom = fakeDom("hello");
    const none: SelectionDocument = { ...dom.doc, getSelection: () => null };
    expect(selectAllIn(dom.root, none)).toBe(false);
    expect(hasSelectionIn(dom.root, none)).toBe(false);
    expect(() => clearSelectionIn(dom.root, none)).not.toThrow();
  });
});
