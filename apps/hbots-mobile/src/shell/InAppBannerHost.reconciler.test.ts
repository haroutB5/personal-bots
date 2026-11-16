// The real presence and banner host through React's reconciler. The banner shows what arrives while
// the Bots list is mounted and nothing that arrived while it was not: a notification taken on
// another tab is acknowledged and gone, it does not pop up when Harout returns.
import { act, createElement, useSyncExternalStore } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const world = vi.hoisted(() => ({
  feed: [] as ReadonlyArray<Record<string, unknown>>,
  feedListeners: new Set<() => void>(),
  acks: [] as string[],
}));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => undefined }),
  },
}));
vi.mock("../motion/useReducedMotion", () => ({ useReducedMotion: () => false }));
vi.mock("./InAppBanner", async () => {
  const { createElement: h } = await import("react");
  return {
    InAppBanner: (props: { notification: { id: string }; leaving: boolean }) =>
      h("InAppBanner", { id: props.notification.id, leaving: props.leaving }),
  };
});

const { InAppPresence } = await import("./InAppPresence");
const { InAppBannerHost } = await import("./InAppBannerHost");
const { createInAppBannerFeed } = await import("./inAppBannerFeed");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACK = { command: "ack" };
const REPORT = { command: "report" };
const recorders = new Map<unknown, (arg: { input: Record<string, unknown> }) => void>([
  [ACK, ({ input }) => void world.acks.push(input.id as string)],
  [REPORT, () => undefined],
]);
const NATIVE = {
  environmentId: "env",
  client: { useAtomCommand: (command: unknown) => recorders.get(command) },
  bots: {
    personalPushAckInApp: ACK,
    personalPushReportForeground: REPORT,
    usePersonalPushInApp: () => ({
      data: useSyncExternalStore(
        (listener) => {
          world.feedListeners.add(listener);
          return () => world.feedListeners.delete(listener);
        },
        () => world.feed,
      ),
    }),
  },
};

function notification(id: string): Record<string, unknown> {
  return {
    id,
    url: `/bots/b/${id}`,
    title: "Bot",
    body: "Reply",
    createdAt: "2026-11-16T10:00:00.000Z",
  };
}

function arrive(...ids: string[]) {
  act(() => {
    world.feed = ids.map(notification);
    for (const listener of world.feedListeners) listener();
  });
}

let tree: ReactTestRenderer | null = null;
const banners = createInAppBannerFeed();

function render(withHost: boolean) {
  const presence = createElement(InAppPresence as never, { native: NATIVE, banners });
  const host = createElement(InAppBannerHost as never, { banners, onOpen: () => undefined });
  const children = withHost ? [presence, host] : [presence];
  act(() => {
    if (tree === null) tree = create(createElement("Root", null, ...children));
    else tree.update(createElement("Root", null, ...children));
  });
}

function bannerNodes() {
  return tree?.root.findAll((node) => (node.type as unknown) === "InAppBanner") ?? [];
}

function shownIds(): string[] {
  return bannerNodes().map((banner) => banner.props.id as string);
}

beforeEach(() => {
  vi.useFakeTimers();
  world.feed = [];
  world.acks.length = 0;
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  world.feedListeners.clear();
  vi.useRealTimers();
});

describe("the in-app banner", () => {
  it("shows a notification that arrives while the Bots list is mounted, and acknowledges it", () => {
    render(true);
    arrive("n1");

    expect(shownIds()).toEqual(["n1"]);
    expect(world.acks).toEqual(["n1"]);
  });

  it("hides again by itself", () => {
    render(true);
    arrive("n1");
    act(() => void vi.advanceTimersByTime(6_000));

    expect(bannerNodes()[0]?.props.leaving).toBe(true);
  });

  it("shows nothing for a notification taken while the Bots list was not mounted", () => {
    render(false);
    arrive("n1");
    expect(world.acks).toEqual(["n1"]);

    render(true);
    expect(shownIds()).toEqual([]);

    act(() => void vi.advanceTimersByTime(60_000));
    expect(shownIds()).toEqual([]);
  });

  it("shows nothing later for one that arrived after the Bots list was left", () => {
    render(true);
    render(false);
    arrive("n1");
    render(true);

    expect(shownIds()).toEqual([]);
    expect(world.acks).toEqual(["n1"]);
  });

  it("shows only the notifications that arrive after it is mounted again", () => {
    render(false);
    arrive("n1");
    render(true);
    arrive("n1", "n2");

    expect(shownIds()).toEqual(["n2"]);
    expect(world.acks).toEqual(["n1", "n2"]);
  });
});
