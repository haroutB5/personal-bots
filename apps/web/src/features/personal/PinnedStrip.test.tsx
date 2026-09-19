import { PersonalBot, PersonalGroup } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { BotAvatar } from "./BotAvatar";
import { PinnedGroupTile, PinnedSnapshotTile, PinnedStrip, PinnedTile } from "./PinnedStrip";

const state = vi.hoisted(() => ({
  timeouts: new Map<number, () => void>(),
  nextTimeoutId: 1,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ open, children }: { open?: boolean; children: React.ReactNode }) => (
    <div data-menu-open={String(open === true)}>{children}</div>
  ),
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("./startBotChat", () => ({
  useStartBotChat: () => ({ start: vi.fn(), starting: false }),
}));

function stubWindow() {
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void) => {
      const id = state.nextTimeoutId++;
      state.timeouts.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => {
      state.timeouts.delete(id);
    },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.timeouts.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const decodeBot = Schema.decodeUnknownSync(PersonalBot);
const decodeGroup = Schema.decodeUnknownSync(PersonalGroup);

function bot(botId: string, name: string) {
  return decodeBot({
    botId,
    name,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "pill",
    avatarColor: "#E8711A",
    modelSelection: { instanceId: "someRuntime", model: "some-model" },
    enabled: true,
    sortOrder: 0,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  });
}

function group(memberBotIds: ReadonlyArray<string>) {
  return decodeGroup({
    groupId: "group-1",
    name: "Launch crew",
    description: "",
    threadId: "group-thread-1",
    maxBotTurns: 6,
    members: memberBotIds.map((botId, index) => ({
      groupId: "group-1",
      botId,
      threadId: `member-thread-${botId}`,
      role: "member",
      sortOrder: index,
      deliveredSeq: 0,
      joinedAt: "2026-09-19T09:00:00.000Z",
      leftAt: null,
    })),
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-19T09:00:00.000Z",
    archivedAt: null,
  });
}

/**
 * The strip is one horizontal list of faces. Everything here is about what it
 * must not lose when the preview line goes: the status, the destination, and
 * the way back out (Unpin).
 */
describe("PinnedStrip", () => {
  it("names the region for assistive tech without printing a heading", async () => {
    stubWindow();
    await act(async () => {
      renderer = create(
        <PinnedStrip>
          <PinnedSnapshotTile row={snapshotRow("bot-ada", "Ada")} />
        </PinnedStrip>,
      );
    });

    expect(renderer!.root.findByProps({ "aria-label": "Pinned" }).type).toBe("section");
    // A row of faces above a chat list explains itself; the uppercase label
    // would be chrome replacing chrome [Grok: subtraction].
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("PINNED");
  });

  function snapshotRow(botId: string, name: string, threadId: string | null = `thread-${botId}`) {
    return {
      botId,
      name,
      avatarShape: "blob" as const,
      avatarColor: "#1A73E8" as const,
      subtitle: "General assistant",
      preview: "cached preview line",
      previewAtMs: 1_757_800_000_000,
      threadId,
      threadTitle: "Cached thread",
      pinned: true,
    };
  }

  /**
   * The cold paint has no live state at all, so a badge here would be a claim
   * the snapshot cannot back. It also has no bot record, so there is no Unpin.
   */
  it("paints a neutral face from a snapshot row", async () => {
    stubWindow();
    await act(async () => {
      renderer = create(
        <PinnedStrip>
          <PinnedSnapshotTile row={snapshotRow("bot-cto", "Cached CTO")} />
        </PinnedStrip>,
      );
    });

    expect(renderer!.root.findAllByType(BotAvatar).map((a) => a.props.label)).toEqual([
      "Cached CTO",
    ]);
    expect(renderer!.root.findAllByProps({ "data-pinned-badge": "attention" })).toEqual([]);
    expect(renderer!.root.findAllByProps({ "data-pinned-badge": "working" })).toEqual([]);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Unpin");
  });

  /**
   * A group is a chat, so it is a tile like any other — the cluster of its
   * members is the face, exactly as in the list row.
   */
  it("renders a pinned group as a tile with its member cluster", async () => {
    stubWindow();
    const bots = [bot("bot-ada", "Ada"), bot("bot-grace", "Grace")];
    const onUnpin = vi.fn();
    await act(async () => {
      renderer = create(
        <PinnedStrip>
          <PinnedGroupTile
            group={group(["bot-ada", "bot-grace"])}
            round={null}
            bots={bots}
            onUnpin={onUnpin}
          />
        </PinnedStrip>,
      );
    });

    const strip = renderer!.root.findByProps({ "aria-label": "Pinned" });
    expect(strip.findAllByType(BotAvatar).map((a) => a.props.label)).toEqual(["Ada", "Grace"]);
    expect(strip.findByProps({ to: "/bots/groups/$groupId" }).props.params).toEqual({
      groupId: "group-1",
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Launch crew");
    // Unpin is reachable from the group's tile too.
    const unpin = strip
      .findAllByType("button")
      .find((button) => JSON.stringify(button.props.children ?? "").includes("Unpin"));
    act(() => unpin!.props.onClick());
    expect(onUnpin).toHaveBeenCalledTimes(1);
  });

  it("shows the working badge and speaks the status after the name", async () => {
    stubWindow();
    await act(async () => {
      renderer = create(
        <PinnedStrip>
          <PinnedTile
            name="CTO"
            avatar={<BotAvatar shape="pill" color="#E8711A" size={56} label="CTO" />}
            badge="working"
            statusLabel="Working"
            target={{ kind: "none" }}
            onUnpin={() => undefined}
          />
        </PinnedStrip>,
      );
    });

    expect(renderer!.root.findAllByProps({ "data-pinned-badge": "working" })).toHaveLength(1);
    expect(renderer!.root.findByProps({ "aria-label": "CTO, Working" })).toBeDefined();
  });

  /**
   * The gesture that replaces the swiped-away "Unpin": hold a face, get the
   * menu, and do not also open the chat underneath.
   */
  it("opens the menu on a long press and swallows the click that follows", async () => {
    stubWindow();
    const onUnpin = vi.fn();
    await act(async () => {
      renderer = create(
        <PinnedStrip>
          <PinnedTile
            name="CTO"
            avatar={<BotAvatar shape="pill" color="#E8711A" size={56} label="CTO" />}
            badge={null}
            statusLabel="Ready"
            target={{ kind: "none" }}
            onUnpin={onUnpin}
          />
        </PinnedStrip>,
      );
    });

    const face = renderer!.root.findByProps({ "aria-label": "CTO, Ready" });
    const openFlag = () => renderer!.root.findAllByProps({ "data-menu-open": "true" }).length > 0;
    expect(openFlag()).toBe(false);

    act(() => {
      face.props.onPointerDown({ pointerType: "touch", clientX: 0, clientY: 0 });
    });
    // Held: the pending timer is the long press, nothing has opened yet.
    expect(openFlag()).toBe(false);
    act(() => {
      for (const run of state.timeouts.values()) run();
    });
    expect(openFlag()).toBe(true);

    let defaultPrevented = false;
    act(() => {
      face.props.onClickCapture({
        preventDefault: () => {
          defaultPrevented = true;
        },
        stopPropagation: () => undefined,
      });
    });
    expect(defaultPrevented).toBe(true);
  });

  it("cancels the long press when the strip is scrolled instead", async () => {
    stubWindow();
    await act(async () => {
      renderer = create(
        <PinnedStrip>
          <PinnedTile
            name="CTO"
            avatar={<BotAvatar shape="pill" color="#E8711A" size={56} label="CTO" />}
            badge={null}
            statusLabel="Ready"
            target={{ kind: "none" }}
            onUnpin={() => undefined}
          />
        </PinnedStrip>,
      );
    });

    const face = renderer!.root.findByProps({ "aria-label": "CTO, Ready" });
    act(() => {
      face.props.onPointerDown({ pointerType: "touch", clientX: 0, clientY: 0 });
      face.props.onPointerMove({ clientX: 40, clientY: 0 });
    });
    expect(state.timeouts.size).toBe(0);
    expect(renderer!.root.findAllByProps({ "data-menu-open": "true" })).toEqual([]);
  });
});
