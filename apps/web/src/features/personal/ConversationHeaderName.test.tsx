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
    expect(String(title!.props.className)).toContain("flex-1");
    // Name and badge never shrink for the title, so the title is the only thing that gives.
    const group = renderer.root.find((node) => node.props["data-name-group"] !== undefined);
    expect(String(group.props.className).split(" ")).toContain("shrink-0");
    expect(className(renderer, (props) => props.role === "img")).toContain("shrink-0");
    // The heading still names the chat for screen readers.
    expect(renderer.root.findByProps({ className: "sr-only" }).props.children).toEqual([
      ", chat ",
      LONG_TITLE,
    ]);
  });

  it("puts the title on the name line, right after the context badge", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ConversationHeaderName name="CTO" chatTitle="Hbots" muted contextBadge="133k" />,
      );
    });
    const group = renderer.root.findByType("h1").parent!;
    const line = group.parent!;
    const kind = (child: (typeof line.children)[number]) =>
      typeof child === "string"
        ? "text"
        : child.props["data-name-group"] !== undefined
          ? "name-group"
          : child.props["data-chat-title"] !== undefined
            ? "title"
            : "other";
    expect(line.children.map(kind)).toEqual(["name-group", "title"]);
    const kinds = group.children.map((child) =>
      typeof child === "string"
        ? "text"
        : child.type === "h1"
          ? "name"
          : child.props.role === "img"
            ? "badge"
            : child.props["data-chat-title"] !== undefined
              ? "title"
              : "bell",
    );
    expect(kinds).toEqual(["name", "bell", "badge"]);
    // One line: a title with under 40 px left wraps to a row the line clips.
    const lineClass = String(line.props.className);
    for (const token of ["flex", "flex-wrap", "h-6", "overflow-hidden"]) {
      expect(lineClass.split(" ")).toContain(token);
    }
    const titleClass = String(titleSpan(renderer)[0]!.props.className).split(" ");
    for (const token of ["min-w-10", "flex-1", "basis-0", "truncate"]) {
      expect(titleClass).toContain(token);
    }
    // Nothing else is rendered below the name line.
    expect(renderer.toJSON()).not.toBeInstanceOf(Array);
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
