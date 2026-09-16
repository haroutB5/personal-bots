import type { ReactNode } from "react";

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ConversationRoutinesPanel } from "./ConversationRoutinesPanel";

const { query } = vi.hoisted(() => ({
  query: {
    data: null as { routines: ReadonlyArray<unknown> } | null,
    error: null as string | null,
  },
}));

vi.mock("./usePersonalAutomation", () => ({ usePersonalRoutines: () => query }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: ReactNode }) => <a {...props}>{children}</a>,
}));

describe("ConversationRoutinesPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", {});
    query.data = null;
    query.error = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders no shell without a matching routine", () => {
    query.data = { routines: [] };
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<ConversationRoutinesPanel environmentId={null} botId="bot-a" />);
    });
    expect(renderer!.toJSON()).toBeNull();
  });

  it("shows no more than three matching routines with their Scheduled labels", () => {
    query.data = {
      routines: ["one", "other", "two", "three", "four"].map((title) => ({
        routineId: title,
        botId: title === "other" ? "bot-b" : "bot-a",
        title,
        enabled: false,
        nextDueAt: null,
        timeZone: "Europe/London",
      })),
    };
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<ConversationRoutinesPanel environmentId={null} botId="bot-a" />);
    });
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("one");
    expect(output).toContain("two");
    expect(output).toContain("three");
    expect(output).not.toContain("four");
    expect(output).toContain("Paused");
    expect(output).toContain("See all");
  });

  it("offers a hide control that reports the dismissal, and none without a handler", () => {
    query.data = {
      routines: [
        {
          routineId: "one",
          botId: "bot-a",
          title: "one",
          enabled: false,
          nextDueAt: null,
          timeZone: "Europe/London",
        },
      ],
    };
    const onHide = vi.fn();
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ConversationRoutinesPanel environmentId={null} botId="bot-a" onHide={onHide} />,
      );
    });
    const hide = renderer!.root.findByProps({ "aria-label": "Hide routines" });
    act(() => hide.props.onClick());
    expect(onHide).toHaveBeenCalledTimes(1);

    let plain: ReactTestRenderer;
    act(() => {
      plain = create(<ConversationRoutinesPanel environmentId={null} botId="bot-a" />);
    });
    expect(plain!.root.findAllByProps({ "aria-label": "Hide routines" })).toEqual([]);
  });
});
