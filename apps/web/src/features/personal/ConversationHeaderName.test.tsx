import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";

import { ConversationHeaderIdentity, conversationChatTitle } from "./ConversationHeaderName";
import type { ConversationCaption } from "./conversationModel";

const LONG_TITLE = "Improve Hbots Chat, Images and the swipe gestures on the phone";

function render(input: {
  name: string;
  chatTitle: string | null;
  muted: boolean;
  contextBadge: string | null;
  caption?: ConversationCaption;
}): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <ConversationHeaderIdentity
        name={input.name}
        chatTitle={input.chatTitle}
        muted={input.muted}
        contextBadge={input.contextBadge}
        caption={input.caption ?? { text: "Opus 5.5", tone: "idle" }}
      />,
    );
  });
  return renderer;
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

describe("ConversationHeaderIdentity", () => {
  it("puts the name over its state caption, in the state's colour", () => {
    const renderer = render({
      name: "CTO",
      chatTitle: "Hbots",
      muted: false,
      contextBadge: null,
      caption: { text: "Working", tone: "working" },
    });
    const h1 = renderer.root.findByType("h1");
    expect(h1.props.children).toEqual(["CTO", expect.anything()]);
    const nameClass = String(h1.props.className).split(" ");
    for (const token of ["truncate", "text-[17px]", "leading-[22px]", "font-semibold"]) {
      expect(nameClass).toContain(token);
    }
    const caption = renderer.root.findByProps({ "data-testid": "chat-caption" });
    expect(caption.props.children).toBe("Working");
    expect(String(caption.props.className)).toContain("var(--personal-state-working)");
  });

  it("gives every tone its own colour, and needs-you the amber one", () => {
    const toneClass = (tone: ConversationCaption["tone"]) =>
      String(
        render({
          name: "CTO",
          chatTitle: null,
          muted: false,
          contextBadge: null,
          caption: { text: "x", tone },
        }).root.findByProps({ "data-testid": "chat-caption" }).props.className,
      );
    expect(toneClass("needs")).toContain("var(--personal-state-needs)");
    expect(toneClass("thinking")).toContain("var(--personal-state-thinking)");
    expect(toneClass("idle")).toContain("var(--personal-state-idle)");
    expect(toneClass("error")).toContain("var(--personal-error)");
    expect(toneClass("info")).toContain("var(--personal-text-secondary)");
  });

  it("keeps the chat's title for screen readers and draws no title line", () => {
    const renderer = render({
      name: "CTO",
      chatTitle: LONG_TITLE,
      muted: false,
      contextBadge: "166k",
    });
    expect(renderer.root.findByProps({ className: "sr-only" }).props.children).toEqual([
      ", chat ",
      LONG_TITLE,
    ]);
    expect(
      renderer.root.findAll((node) => node.props["data-chat-title"] !== undefined),
    ).toHaveLength(0);
    // The name keeps its width; the context badge never shrinks.
    const group = renderer.root.find((node) => node.props["data-name-group"] !== undefined);
    expect(String(group.props.className)).toContain("min-w-0");
    const badge = renderer.root.find((node) => node.props.role === "img");
    expect(String(badge.props.className)).toContain("shrink-0");
  });

  it("hides the title for an untitled chat and shows the muted bell", () => {
    const renderer = render({
      name: "CTO",
      chatTitle: "New chat",
      muted: true,
      contextBadge: null,
    });
    expect(renderer.root.findByType("h1").props.children).toEqual(["CTO", null]);
    expect(
      renderer.root.findAll((node) => node.props["data-chat-title"] !== undefined),
    ).toHaveLength(0);
    expect(renderer.root.findAll((node) => node.type === "svg").length).toBeGreaterThan(0);
  });
});
