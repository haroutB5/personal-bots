import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vite-plus/test";

import { ConversationSubtitle } from "./ConversationSubtitle";

function render(props: Parameters<typeof ConversationSubtitle>[0]): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ConversationSubtitle {...props} />);
  });
  return renderer;
}

function classOf(renderer: ReactTestRenderer, text: string): string {
  const node = renderer.root.find(
    (candidate) =>
      typeof candidate.type === "string" &&
      candidate.type === "span" &&
      candidate.children.some((child) => typeof child === "string" && child === text),
  );
  return String(node.props.className);
}

describe("ConversationSubtitle", () => {
  it("shows the status then the model label, and no provider name or bot title", () => {
    const renderer = render({ state: "working", status: "Working", modelLabel: "Opus 5.5 · H" });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Working");
    expect(text).toContain("Opus 5.5 · H");
    expect(text).not.toContain("Claude Code");
    expect(text.indexOf("Working")).toBeLessThan(text.indexOf("Opus 5.5 · H"));
  });

  it("keeps the status from shrinking and lets only the model label truncate", () => {
    const renderer = render({
      state: "delegating",
      status: "Waiting on Planner",
      modelLabel: "Sonnet 5.5 · H",
    });
    expect(classOf(renderer, "Waiting on Planner")).toContain("shrink-0");
    const label = renderer.root.find((node) => node.props["data-testid"] === "chat-model-label");
    expect(String(label.props.className)).toContain("truncate");
    expect(String(label.props.className)).toContain("min-w-0");
  });

  it("omits the separator when the bot has no model", () => {
    const renderer = render({ state: "idle", status: "Idle", modelLabel: null });
    expect(
      renderer.root.findAll((node) => node.props["data-testid"] === "chat-model-label"),
    ).toHaveLength(0);
  });
});
