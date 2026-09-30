import { act, create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { PRELOAD_CHAT_IDLE_MS, usePreloadChatRoute } from "./usePreloadChatRoute";

const state = vi.hoisted(() => ({
  off: new Set<string>(),
  idle: [] as Array<{ work: () => void; fallbackMs: number | undefined }>,
  loaded: 0,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    routesById: { "/_personal/bots_/$botId/$threadId": { id: "chat" } },
    loadRouteChunk: () => {
      state.loaded += 1;
      return Promise.resolve();
    },
  }),
}));
vi.mock("./perfFlags", () => ({
  perfOptimizationOn: (name: string) => !state.off.has(name),
  whenIdle: (work: () => void, fallbackMs?: number) => {
    state.idle.push({ work, fallbackMs });
    return () => undefined;
  },
}));

function Probe({ ready }: { ready: boolean }) {
  usePreloadChatRoute(ready);
  return null;
}

afterEach(() => {
  state.off.clear();
  state.idle = [];
  state.loaded = 0;
  vi.unstubAllGlobals();
});

const mount = async (ready: boolean) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    create(<Probe ready={ready} />);
  });
};

it("waits for the first paint", async () => {
  await mount(false);
  expect(state.idle).toHaveLength(0);
});

it("loads the chat code on a short idle deadline once the list paints (H8)", async () => {
  await mount(true);
  expect(state.idle).toHaveLength(1);
  expect(state.idle[0]!.fallbackMs).toBe(PRELOAD_CHAT_IDLE_MS);
  state.idle[0]!.work();
  expect(state.loaded).toBe(1);
});

it("keeps the old idle deadline with preload-chat-soon off, and nothing with preload-chat off", async () => {
  state.off.add("preload-chat-soon");
  await mount(true);
  expect(state.idle[0]!.fallbackMs).toBeUndefined();
  state.idle = [];
  state.off.add("preload-chat");
  await mount(true);
  expect(state.idle).toHaveLength(0);
});
