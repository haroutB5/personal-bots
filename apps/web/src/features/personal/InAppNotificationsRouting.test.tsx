import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { InAppNotifications } from "./InAppNotifications";

const state = vi.hoisted(() => ({
  feed: [] as Array<Record<string, unknown>>,
  pushed: [] as string[],
  acks: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ history: { push: (url: string) => state.pushed.push(url) } }),
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: state.feed }) }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (target: unknown) => {
    state.acks.push(target);
    return { _tag: "Success", value: {} };
  },
}));
vi.mock("./usePersonalAutomation", () => ({
  personalPushAckInApp: {},
  personalPushInAppFeed: () => ({}),
  personalPushReportForeground: {},
}));
vi.mock("./usePersonalBots", () => ({ usePersonalEnvironmentId: () => "env-1" }));
// Not connected: the foreground heartbeat stays out of this test.
vi.mock("./PersonalOfflineBanner", () => ({ usePersonalConnectionPhase: () => "connecting" }));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => null }));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.feed = [];
  state.pushed = [];
  state.acks = [];
  vi.unstubAllGlobals();
});

const note = (id: string, url: string) => ({
  id,
  title: "Frontend replied",
  body: "Open the chat to read it.",
  url,
  preview: "Done.",
});

async function renderOn(path: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("window", {
    location: { pathname: path },
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  });
  await act(async () => {
    renderer = create(<InAppNotifications />);
  });
}

describe("in-app banner routing", () => {
  it("opens the chat the notification is about, not the screen that was open", async () => {
    state.feed = [
      note("chat-reply:t1:1", "/bots/bot-1/t1"),
      note("chat-reply:t2:2", "/bots/bot-2/t2"),
    ];
    await renderOn("/tasks");
    expect(state.acks).toHaveLength(2);
    // The newest one is the banner; tapping it opens that chat.
    const open = renderer!.root.findAllByType("button")[0]!;
    await act(async () => open.props.onClick());
    expect(state.pushed).toEqual(["/bots/bot-2/t2"]);
    expect(renderer!.toJSON()).toBeNull();
  });

  it("opens a task completion on its task page", async () => {
    state.feed = [note("task-done:k1", "/tasks/k1")];
    await renderOn("/bots");
    await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
    expect(state.pushed).toEqual(["/tasks/k1"]);
  });

  it("shows nothing for the chat already on screen", async () => {
    state.feed = [note("chat-reply:t1:1", "/bots/bot-1/t1")];
    await renderOn("/bots/bot-1/t1");
    expect(renderer!.toJSON()).toBeNull();
    expect(state.acks).toHaveLength(1);
  });
});
