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

  it("keeps the status whole and makes the model label give way at 390 px (1.66.44)", () => {
    const renderer = render({
      state: "delegating",
      status: "Waiting on Planner",
      modelLabel: "Sonnet 5.5 · H · peak",
    });
    // One row tall, no wrapping: the model label is the part that shrinks and
    // ends in an ellipsis, so a long label can never cut the status to "Id…".
    const line = renderer.root.find((node) => node.props["data-testid"] === "chat-status-line");
    const lineClass = String(line.props.className);
    expect(lineClass).toContain("overflow-hidden");
    expect(lineClass).toContain("h-[18px]");
    expect(lineClass).not.toContain("flex-wrap");
    const label = renderer.root.find((node) => node.props["data-testid"] === "chat-model-label");
    const labelClass = String(label.props.className);
    expect(labelClass).toContain("truncate");
    expect(labelClass).toContain("shrink-[100]");
    // The status never gives way to the model; it only ellipsises when it alone
    // is wider than the line.
    expect(classOf(renderer, "Waiting on Planner")).toContain("truncate");
    expect(classOf(renderer, "Waiting on Planner")).toContain("max-w-full");
    expect(classOf(renderer, "Waiting on Planner")).toContain("shrink-0");
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

  it("drops the word Idle, keeps the dot and the marker, while a marker rides the label (1.66.48)", () => {
    for (const [label, note] of [
      ["Sonnet 5.5 · H · sched", "Scheduled model until 07:00"],
      ["Sonnet 5.5 · H · peak", "DeepSeek peak until 11:00"],
      ["Sonnet 5.5 · H · fallback", "on fallback until about 14:30 (Codex usage limit)"],
    ] as const) {
      const renderer = render({
        state: "idle",
        status: "Idle",
        modelLabel: label,
        modelNote: note,
      });
      const marker = renderer.root.find((node) => node.props["data-testid"] === "chat-model-label");
      const baseAndMarker = label.split(" · ");
      const markerWord = baseAndMarker[baseAndMarker.length - 1];
      const tail = renderer.root.find((node) => node.props["data-testid"] === "chat-model-marker");
      expect(tail.children.join("")).toBe(` · ${markerWord}`);
      // The marker never shrinks; the model name in front of it is what gives way.
      expect(String(tail.props.className)).toContain("shrink-0");
      const base = marker.findAll(
        (node) =>
          node.type === "span" &&
          String(node.props.className) === "min-w-0 truncate" &&
          node.children.join("") === label.slice(0, -` · ${markerWord}`.length),
      );
      expect(base).toHaveLength(1);
      // No visible "Idle" and no leading separator; the dot is still there and the
      // word stays for screen readers.
      expect(
        renderer.root.findAll(
          (node) =>
            node.type === "span" &&
            !String(node.props.className).includes("sr-only") &&
            node.children.some((child) => child === "Idle"),
        ),
      ).toHaveLength(0);
      expect(
        renderer.root.findAll(
          (node) => node.type === "span" && String(node.props.className).includes("size-2"),
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(renderer.toJSON())).toContain("Idle");
      // The dropped word's room goes to the marker: a tighter dot gap and 12px text.
      const line = renderer.root.find((node) => node.type === "p");
      expect(String(line.props.className)).toContain("text-[12px]");
      expect(String(line.props.className)).toContain("gap-1 ");
      // The label still gives way, never the name group: no min-width floor on it.
      expect(String(marker.props.className)).not.toContain("min-w-[");
    }
  });

  it("keeps Idle when no marker is shown, and every non-idle status with a marker", () => {
    const plain = render({ state: "idle", status: "Idle", modelLabel: "Sonnet 5.5 · H" });
    expect(JSON.stringify(plain.toJSON())).toContain("Idle");
    expect(classOf(plain, "Idle")).toContain("shrink-0");
    expect(String(plain.root.find((node) => node.type === "p").props.className)).toContain(
      "text-[13px]",
    );
    const working = render({
      state: "working",
      status: "Working",
      modelLabel: "Sonnet 5.5 · H · sched",
      modelNote: "Scheduled model until 07:00",
    });
    expect(classOf(working, "Working")).toContain("shrink-0");
    const broke = render({
      state: "idle",
      status: "Update broke Claude Code",
      modelLabel: "Sonnet 5.5 · H · peak",
      modelNote: "DeepSeek peak until 11:00",
    });
    expect(classOf(broke, "Update broke Claude Code")).toContain("shrink-0");
  });

  it("omits the separator when the bot has no model", () => {
    const renderer = render({ state: "idle", status: "Idle", modelLabel: null });
    expect(
      renderer.root.findAll((node) => node.props["data-testid"] === "chat-model-label"),
    ).toHaveLength(0);
  });

  it("lets an idle bot give the word 'Idle' up on a 360 px phone, never a busy status", () => {
    const idle = render({ state: "idle", status: "Idle", modelLabel: "Sonnet 5.5 · H" });
    expect(classOf(idle, "Idle")).toContain("max-[380px]:sr-only");
    const separator = idle.root.find(
      (node) =>
        node.type === "span" && String(node.props.className ?? "").includes("max-[380px]:hidden"),
    );
    expect(separator).toBeDefined();
    const working = render({ state: "working", status: "Working", modelLabel: "Sonnet 5.5 · H" });
    expect(classOf(working, "Working")).not.toContain("max-[380px]:sr-only");
    // Without a model there is nothing for the room to go to, so the word stays.
    const alone = render({ state: "idle", status: "Idle", modelLabel: null });
    expect(classOf(alone, "Idle")).not.toContain("max-[380px]:sr-only");
  });
});
