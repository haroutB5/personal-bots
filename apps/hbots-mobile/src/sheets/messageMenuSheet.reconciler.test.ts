// The Message sheet through React's reconciler with stand-in leaves: what the select view draws.
import { createElement, act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", async () => {
  const stub = await import("../chat/testSupport/reactNativeStub");
  const { createElement: h } = await import("react");
  return {
    ...stub,
    TextInput: (props: Record<string, unknown>) => h("TextInput", props),
    useWindowDimensions: () => ({ width: 360, height: 785 }),
  };
});
vi.mock("expo-clipboard", () => ({ setStringAsync: () => Promise.resolve(true) }));
vi.mock("./SheetShell", async () => {
  const { createElement: h } = await import("react");
  return {
    SheetShell: (props: { visible: boolean; title: string; children?: React.ReactNode }) =>
      props.visible ? h("Sheet", { title: props.title }, props.children) : null,
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
function mount(request: Request, onRequest: (next: NonNullable<Request>) => void = () => {}) {
  act(() => {
    renderer = create(
      createElement(MessageMenuSheet, {
        request,
        onRequest,
        onClose: () => {},
        onReply: () => {},
      }),
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
    expect(reader[0]!.props.children).toBe(MESSAGE.text);
  });

  it("C2 the menu's Select text row asks for select mode on the same message, nothing preselected", () => {
    const onRequest = vi.fn();
    const tree = mount({ kind: "menu", message: MESSAGE }, onRequest);
    const row = hosts(tree, "Action", (props) => props.label === "Select text")[0]!;
    act(() => row.props.onPress());
    expect(onRequest).toHaveBeenCalledWith({ kind: "select", message: MESSAGE, hit: null });
    expect(hosts(tree, "Text")).toHaveLength(0);
  });
});
