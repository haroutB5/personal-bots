import { describe, expect, it } from "vite-plus/test";

import { inertOutside } from "./overlayInert";

interface FakeElement {
  readonly id: string;
  inert: boolean;
  parentElement: FakeElement | null;
  children: FakeElement[];
}

const element = (id: string, children: FakeElement[] = []): FakeElement => {
  const node: FakeElement = { id, inert: false, parentElement: null, children };
  for (const child of children) child.parentElement = node;
  return node;
};

/** body > [aside, main > [chat, overlay]] with the overlay open inside main. */
const tree = () => {
  const aside = element("aside");
  const chat = element("chat");
  const overlay = element("overlay");
  const main = element("main", [chat, overlay]);
  const body = element("body", [aside, main]);
  return { aside, chat, overlay, main, body };
};

const inertIds = (nodes: ReadonlyArray<FakeElement>) =>
  nodes.filter((node) => node.inert).map((node) => node.id);

describe("overlay inert background", () => {
  it("inerts every sibling up the ancestor chain, never the overlay or its ancestors", () => {
    const nodes = tree();
    const undo = inertOutside(nodes.overlay as unknown as Element);

    expect(inertIds(Object.values(nodes))).toEqual(["aside", "chat"]);
    // The overlay's own ancestors stay interactive, or the dialog would be
    // inert along with the page behind it.
    expect(nodes.main.inert).toBe(false);
    expect(nodes.overlay.inert).toBe(false);

    undo();
    expect(inertIds(Object.values(nodes))).toEqual([]);
  });

  it("leaves an element that was already inert alone, including on undo", () => {
    const nodes = tree();
    nodes.aside.inert = true;

    inertOutside(nodes.overlay as unknown as Element)();

    expect(nodes.aside.inert).toBe(true);
    expect(nodes.chat.inert).toBe(false);
  });

  it("does nothing without an overlay element", () => {
    expect(() => inertOutside(null)()).not.toThrow();
  });
});
