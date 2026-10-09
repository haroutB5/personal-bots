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

  it("clips the model label whole instead of cutting it, and ellipsises a status that is too long (1.60.45)", () => {
    const renderer = render({
      state: "delegating",
      status: "Waiting on Planner",
      modelLabel: "Sonnet 5.5 · H",
    });
    // One row tall, wrapping: a model label that does not fit beside the status drops to a
    // second row and is clipped away, so no "Sonnet 5.…" is ever drawn.
    const line = renderer.root.find((node) => node.props["data-testid"] === "chat-status-line");
    const lineClass = String(line.props.className);
    expect(lineClass).toContain("flex-wrap");
    expect(lineClass).toContain("overflow-hidden");
    expect(lineClass).toContain("h-[18px]");
    const label = renderer.root.find((node) => node.props["data-testid"] === "chat-model-label");
    expect(String(label.props.className)).toContain("shrink-0");
    expect(String(label.props.className)).toContain("whitespace-nowrap");
    expect(String(label.props.className)).not.toContain("truncate");
    // A status wider than the line ends in an ellipsis rather than being cut off.
    expect(classOf(renderer, "Waiting on Planner")).toContain("truncate");
    expect(classOf(renderer, "Waiting on Planner")).toContain("max-w-full");
  });

  it("keeps a working bot reading as working, however long it has been quiet", () => {
    const renderer = render({ state: "working", status: "Working", modelLabel: "Sonnet 5.5 · M" });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Working");
    expect(text).not.toContain("No response");
    const dot = renderer.root.findAll(
      (node) => node.type === "span" && node.props["aria-hidden"] === "true",
    )[0];
    expect(String(dot?.props.className)).toContain("--personal-live");
  });

  it("omits the separator when the bot has no model", () => {
    const renderer = render({ state: "idle", status: "Idle", modelLabel: null });
    expect(
      renderer.root.findAll((node) => node.props["data-testid"] === "chat-model-label"),
    ).toHaveLength(0);
  });
});
