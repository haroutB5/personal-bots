// The Message sheet through React's reconciler with stand-in leaves: what the select view draws.
import { createElement, act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ clearSelection: vi.fn() }));

vi.mock("react-native", async () => {
  const stub = await import("../chat/testSupport/reactNativeStub");
  const { createElement: h } = await import("react");
  return {
    ...stub,
    TextInput: (props: Record<string, unknown>) => h("TextInput", props),
    useWindowDimensions: () => ({ width: 360, height: 785 }),
    findNodeHandle: () => 7,
  };
});
vi.mock("../chat/textSelectNative", () => ({
  textHitAt: () => Promise.resolve(null),
  selectWordAt: () => Promise.resolve(null),
  watchSelection: () => Promise.resolve(true),
  clearSelection: native.clearSelection,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: () => Promise.resolve(true) }));
vi.mock("./SheetShell", async () => {
  const { createElement: h } = await import("react");
  return {
    SheetShell: (props: {
      visible: boolean;
      title: string;
      onClose: () => void;
      onBack?: () => void;
      children?: React.ReactNode;
    }) =>
      props.visible
        ? h(
            "Sheet",
            { title: props.title, onClose: props.onClose, onBack: props.onBack },
            props.children,
          )
        : null,
    SheetAction: (props: { label: string; onPress: () => void }) => h("Action", props),
    SheetCancel: (props: { onPress: () => void }) => h("Cancel", props),
  };
});

const { MessageMenuSheet } = await import("./MessageMenuSheet");
type Request = Parameters<typeof MessageMenuSheet>[0]["request"];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MESSAGE = {
  messageId: "a0",
  name: "Bot",
  text: "Plan\n\nRun fast now.",
  sentAt: null,
  streaming: false,
};

let renderer: ReactTestRenderer | null = null;
function mount(
  request: Request,
  onRequest: (next: NonNullable<Request>) => void = () => {},
  onClose: () => void = () => {},
) {
  act(() => {
    renderer = create(
      createElement(MessageMenuSheet, {
        request,
        onRequest,
        onClose,
        onReply: () => {},
      }),
      { createNodeMock: () => ({}) },
    );
  });
  return renderer!;
}

function hosts(
  tree: ReactTestRenderer,
  type: string,
  where: (props: Record<string, unknown>) => boolean = () => true,
) {
  return tree.root.findAll((node) => node.type === type && where(node.props));
}

/** What the user reads in a Text: its own string children and those of the Text nested in it. */
function visibleText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : visibleText(child)))
    .join("");
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("MessageMenuSheet select view", () => {
  it("C1 select mode draws one selectable Text labelled Message text and no TextInput", () => {
    const tree = mount({ kind: "select", message: MESSAGE, hit: null });
    expect(hosts(tree, "TextInput")).toHaveLength(0);
    const reader = hosts(tree, "Text", (props) => props.accessibilityLabel === "Message text");
    expect(reader).toHaveLength(1);
    expect(reader[0]!.props.selectable).toBe(true);
    expect(visibleText(reader[0]!)).toBe("Plan\n\nRun fast now.");
  });

  it("C3 a reply that was still streaming shows the note above the text, a finished one does not", () => {
    const note = "Still writing. This is the text so far.";
    const live = mount({ kind: "select", message: { ...MESSAGE, streaming: true }, hit: null });
    expect(hosts(live, "Text").some((node) => node.props.children === note)).toBe(true);
    act(() => renderer?.unmount());
    const done = mount({ kind: "select", message: MESSAGE, hit: null });
    expect(hosts(done, "Text").some((node) => node.props.children === note)).toBe(false);
  });

  it("C2 the menu's Select text row asks for select mode on the same message, nothing preselected", () => {
    const onRequest = vi.fn();
    const tree = mount({ kind: "menu", message: MESSAGE }, onRequest);
    const row = hosts(tree, "Action", (props) => props.label === "Select text")[0]!;
    act(() => row.props.onPress());
    expect(onRequest).toHaveBeenCalledWith({ kind: "select", message: MESSAGE, hit: null });
    expect(hosts(tree, "Text")).toHaveLength(0);
  });

  it("C4 Back clears a selection first, and closes only when nothing is selected", async () => {
    native.clearSelection.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const onClose = vi.fn();
    const tree = mount({ kind: "select", message: MESSAGE, hit: null }, () => {}, onClose);
    const sheet = hosts(tree, "Sheet")[0]!;
    await act(async () => sheet.props.onBack());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => sheet.props.onBack());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
