import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { BotInstructionsField } from "./BotInstructionsField";

let renderer: ReactTestRenderer | undefined;
const blur = vi.fn();

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  blur.mockClear();
  vi.unstubAllGlobals();
});

/** A textarea whose text measures `contentHeight` px, with 22px lines and 10px padding. */
const mount = async (contentHeight: number, onChange: (value: string) => void = () => {}) => {
  // oxlint-disable-next-line t3code/require-disposable-render -- this file's react-test-renderer harness owns the act environment
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("getComputedStyle", () => ({
    paddingTop: "10px",
    paddingBottom: "10px",
    borderTopWidth: "1px",
    borderBottomWidth: "1px",
    lineHeight: "22px",
  }));
  await act(async () => {
    renderer = create(<BotInstructionsField value="long instructions" onChange={onChange} />, {
      createNodeMock: () => ({ scrollHeight: contentHeight, style: { height: "" }, blur }),
    });
  });
  if (renderer === undefined) throw new Error("render failed");
  return renderer;
};

const textarea = (tree: ReactTestRenderer) => tree.root.findByType("textarea");
const control = (tree: ReactTestRenderer) => tree.root.findAllByType("button")[0];
const fades = (tree: ReactTestRenderer) =>
  tree.root.findAll((node) => node.props["data-instructions-fade"] !== undefined);

it("opens long instructions collapsed to about six lines with a fade and Show all", async () => {
  const tree = await mount(900);
  expect(textarea(tree).props.style).toEqual({ height: 154 });
  expect(fades(tree)).toHaveLength(1);
  expect(control(tree)?.children).toEqual(["Show all"]);
  expect(control(tree)?.props["aria-expanded"]).toBe(false);
});

it("shows all the text when Show all is pressed, and collapses again on Show less", async () => {
  const tree = await mount(900);
  await act(async () => control(tree)?.props.onClick());
  expect(textarea(tree).props.style).toEqual({ height: 902 });
  expect(fades(tree)).toHaveLength(0);
  expect(control(tree)?.children).toEqual(["Show less"]);
  await act(async () => control(tree)?.props.onClick());
  expect(blur).toHaveBeenCalledTimes(1);
  expect(textarea(tree).props.style).toEqual({ height: 154 });
  expect(control(tree)?.children).toEqual(["Show all"]);
});

it("expands when the box gets focus", async () => {
  const tree = await mount(900);
  await act(async () => textarea(tree).props.onFocus());
  expect(textarea(tree).props.style).toEqual({ height: 902 });
  expect(control(tree)?.children).toEqual(["Show less"]);
});

it("keeps the same box and passes every edit on, collapsed or expanded", async () => {
  const edits: string[] = [];
  const tree = await mount(900, (value) => edits.push(value));
  const before = textarea(tree);
  await act(async () => before.props.onChange({ target: { value: "edited while collapsed" } }));
  await act(async () => control(tree)?.props.onClick());
  await act(async () => textarea(tree).props.onChange({ target: { value: "edited expanded" } }));
  await act(async () => control(tree)?.props.onClick());
  expect(edits).toEqual(["edited while collapsed", "edited expanded"]);
  expect(textarea(tree).props.value).toBe("long instructions");
  expect(textarea(tree).props.id).toBe("bot-instructions");
});

it("offers no control and no fade when the instructions already fit", async () => {
  const tree = await mount(64);
  expect(control(tree)).toBeUndefined();
  expect(fades(tree)).toHaveLength(0);
  expect(textarea(tree).props.style).toEqual({ height: 122 });
});

it("uses no transition, so reduced motion needs no special case", async () => {
  const tree = await mount(900);
  expect(String(textarea(tree).props.className)).not.toMatch(/transition|animate|duration/u);
});
