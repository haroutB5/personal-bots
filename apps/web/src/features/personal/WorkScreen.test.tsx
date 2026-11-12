import type { ReactNode } from "react";

import {
  buildWorkTimeline,
  workBarsById,
  type WorkChatTurn,
} from "@hbots/personal-client/work/workTimeline";
import type { PersonalBot } from "@t3tools/contracts";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { act } from "../../../test/rendererAct";
import { WorkTimelineView, type WorkDetail } from "./WorkScreen";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: async () => true }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => ({}) }));
vi.mock("./usePersonalAutomation", () => ({ personalTaskCancel: {} }));
vi.mock("./usePersonalBots", () => ({}));
vi.mock("./useBotShells", () => ({}));
vi.mock("./useWorkingProgress", () => ({}));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => <i data-avatar="" /> }));

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const MIN = 60_000;

const bot = (botId: string, name: string) =>
  ({ botId, name, avatarShape: "circle", avatarColor: "blue" }) as unknown as PersonalBot;
const botById = new Map([
  ["lead", bot("lead", "Poteto")],
  ["ship", bot("ship", "Shipper")],
  ["rest", bot("rest", "Architect")],
]);

const chat = (overrides: Partial<WorkChatTurn>): WorkChatTurn => ({
  threadId: "t1",
  turnId: "turn1",
  botId: "lead",
  title: "Build the timeline",
  startedMs: NOW - 30 * MIN,
  endedMs: null,
  needsYou: false,
  ...overrides,
});

const timelineOf = (chats: ReadonlyArray<WorkChatTurn>) =>
  buildWorkTimeline({
    tasks: [],
    chats,
    botIds: ["lead", "ship", "rest"],
    nowMs: NOW,
    rangeMs: 4 * 60 * MIN,
  });

function render(
  chats: ReadonlyArray<WorkChatTurn>,
  pick: string | null = null,
  onSelect: (barId: string | null) => void = () => undefined,
): ReactTestRenderer {
  const timeline = timelineOf(chats);
  const bar = pick === null ? undefined : workBarsById(timeline).get(pick);
  const detail: WorkDetail | null =
    bar === undefined
      ? null
      : { bar, initiator: "Started by you", step: "Running the tests", canStop: false };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <WorkTimelineView
        timeline={timeline}
        range="4h"
        onRange={() => undefined}
        botById={botById}
        detail={detail}
        onSelect={onSelect}
        onStop={() => undefined}
        busy={false}
        error={null}
      />,
    );
  });
  return renderer;
}

const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
const byTestId = (renderer: ReactTestRenderer, id: string) =>
  renderer.root.findAll(
    (node) => node.props["data-testid"] === id && typeof node.type === "string",
  );

describe("WorkTimelineView", () => {
  it("shows who works, on what, for how long, and who is idle", () => {
    const renderer = render([chat({})]);
    const json = text(renderer);
    expect(json).toContain("Poteto");
    expect(json).toContain("Build the timeline");
    expect(json).toContain("Working · 30 min");
    expect(json).toContain("Started by you · Build the timeline");
    expect(json).toContain("Shipper, Architect");
    expect(byTestId(renderer, "work-needs")).toHaveLength(0);
    expect(byTestId(renderer, "work-bar-chat:t1")[0]?.props["data-tone"]).toBe("working");
  });

  it("puts work that waits for the owner in the banner", () => {
    const renderer = render([
      chat({}),
      chat({
        threadId: "t2",
        botId: "ship",
        title: "Which release?",
        startedMs: NOW - 50 * MIN,
        endedMs: NOW - 20 * MIN,
        needsYou: true,
      }),
    ]);
    const banner = byTestId(renderer, "work-needs");
    expect(banner).toHaveLength(1);
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("1 bot is waiting for you");
    expect(json).toContain("Which release?");
    expect(byTestId(renderer, "work-bar-chat:t2")[0]?.props["data-tone"]).toBe("needsYou");
  });

  it("opens the detail of a tapped bar with the bot's own step", () => {
    const picked: Array<string | null> = [];
    const closed = render([chat({})], null, (barId) => picked.push(barId));
    act(() => byTestId(closed, "work-bar-chat:t1")[0]?.props.onClick());
    expect(picked).toEqual(["chat:t1"]);
    expect(byTestId(closed, "work-detail")).toHaveLength(0);

    const open = render([chat({})], "chat:t1");
    expect(byTestId(open, "work-detail")).toHaveLength(1);
    expect(text(open)).toContain("Running the tests");
    expect(text(open)).toContain("Open chat");
    expect(text(open)).not.toContain("Stop");
  });

  it("says so when nothing ran in the range", () => {
    const renderer = render([]);
    expect(text(renderer)).toContain("No bot has worked in this time range.");
    expect(text(renderer)).toContain("Poteto, Shipper, Architect");
  });
});
