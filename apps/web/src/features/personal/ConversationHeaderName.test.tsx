import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";

import { ConversationHeaderName, conversationChatTitle } from "./ConversationHeaderName";

const LONG_TITLE = "Improve Hbots Chat, Images and the swipe gestures on the phone";

function titleSpan(renderer: ReactTestRenderer) {
  return renderer.root.findAll((node) => node.props["data-chat-title"] !== undefined);
}

function className(
  renderer: ReactTestRenderer,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  const node = renderer.root.find(
    (candidate) => typeof candidate.type === "string" && predicate(candidate.props),
  );
  return String(node.props.className);
}

describe("conversationChatTitle", () => {
  it("hides an untitled chat", () => {
    expect(conversationChatTitle(undefined)).toBeNull();
    expect(conversationChatTitle("")).toBeNull();
    expect(conversationChatTitle("  ")).toBeNull();
    expect(conversationChatTitle("New chat")).toBeNull();
  });

  it("keeps a real title", () => {
    expect(conversationChatTitle(" Fix the header ")).toBe("Fix the header");
  });
});

describe("ConversationHeaderName", () => {
  it("lets a long title truncate while the name and context badge keep their width", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ConversationHeaderName
          name="CTO"
          chatTitle={LONG_TITLE}
          muted={false}
          contextBadge="166k"
        />,
      );
    });
    const [title] = titleSpan(renderer);
    expect(title).toBeDefined();
    expect(title!.props.title).toBe(LONG_TITLE);
    expect(String(title!.props.className)).toContain("truncate");
    expect(String(title!.props.className)).toContain("min-w-0");
    // Name and badge never shrink, so the title is the only thing that gives.
    expect(String(renderer.root.findByType("h1").props.className)).toContain("shrink-0");
    expect(className(renderer, (props) => props.role === "img")).toContain("shrink-0");
    // The heading still names the chat for screen readers.
    expect(renderer.root.findByProps({ className: "sr-only" }).props.children).toEqual([
      ", chat ",
      LONG_TITLE,
    ]);
  });

  it("shows nothing extra for an untitled chat", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ConversationHeaderName
          name="CTO"
          chatTitle="New chat"
          muted={false}
          contextBadge={null}
        />,
      );
    });
    expect(titleSpan(renderer)).toHaveLength(0);
    expect(renderer.root.findByType("h1").props.children).toEqual(["CTO", null]);
  });

  it("follows the chat title live when it is auto-titled or renamed", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ConversationHeaderName name="CTO" chatTitle="New chat" muted={false} contextBadge="12k" />,
      );
    });
    expect(titleSpan(renderer)).toHaveLength(0);
    act(() => {
      renderer.update(
        <ConversationHeaderName
          name="CTO"
          chatTitle="Plan the week"
          muted={false}
          contextBadge="12k"
        />,
      );
    });
    expect(titleSpan(renderer)[0]!.props.title).toBe("Plan the week");
    act(() => {
      renderer.update(
        <ConversationHeaderName
          name="CTO"
          chatTitle="Tennis booking"
          muted={false}
          contextBadge="12k"
        />,
      );
    });
    expect(titleSpan(renderer)[0]!.props.title).toBe("Tennis booking");
    expect(titleSpan(renderer)).toHaveLength(1);
  });
});
