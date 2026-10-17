import type { ReactNode } from "react";

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BotRoutinesSection } from "./BotRoutinesSection";

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

const routine = (routineId: string, botId: string, enabled: boolean) => ({
  routineId,
  botId,
  title: routineId,
  enabled,
  schedule: null,
  eventLabel: "A new email",
  lastFiredAt: null,
  nextDueAt: null,
  timeZone: "Europe/London",
});

describe("BotRoutinesSection", () => {
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

  function render(section = () => <BotRoutinesSection environmentId={null} botId="bot-a" />) {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(section());
    });
    return renderer!;
  }

  it("says No routines yet for a bot with none", () => {
    query.data = { routines: [routine("other", "bot-b", true)] };
    const output = JSON.stringify(render().toJSON());
    expect(output).toContain("No routines yet");
    expect(output).not.toContain("other");
  });

  it("lists only this bot's routines, enabled first, each opening its routine page", () => {
    query.data = {
      routines: [
        routine("paused-one", "bot-a", false),
        routine("other-bot", "bot-b", true),
        routine("live-one", "bot-a", true),
        routine("live-two", "bot-a", true),
      ],
    };
    const renderer = render();
    const output = JSON.stringify(renderer.toJSON());
    expect(output).not.toContain("other-bot");
    expect(output.indexOf("live-one")).toBeLessThan(output.indexOf("live-two"));
    expect(output.indexOf("live-two")).toBeLessThan(output.indexOf("paused-one"));
    expect(output).toContain("Paused");
    expect([
      ...new Set(
        renderer.root
          .findAllByProps({ to: "/tasks/routines/$routineId" })
          .map((link) => link.props.params.routineId),
      ),
    ]).toEqual(["live-one", "live-two", "paused-one"]);
  });

  it("waits before saying it is empty and reports a failed load", () => {
    expect(JSON.stringify(render().toJSON())).toContain("Loading routines…");

    query.error = "offline";
    const output = JSON.stringify(render().toJSON());
    expect(output).toContain("Couldn't load this bot's routines.");
    expect(output).not.toContain("No routines yet");
  });
});
