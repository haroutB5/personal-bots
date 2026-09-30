import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ConversationShellHeader, useChatMountAfterFirstPaint } from "./ConversationShellFirst";

const state = vi.hoisted(() => ({ off: new Set<string>(), frames: [] as Array<() => void> }));

vi.mock("./perfFlags", () => ({ perfOptimizationOn: (name: string) => !state.off.has(name) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("~/state/server", () => ({ primaryServerProvidersAtom: {} }));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => <span data-avatar="" /> }));
vi.mock("./botModelLabel", () => ({ botModelShortLabel: () => "Sonnet 5.5 · M" }));
vi.mock("./usePersonalBackTarget", () => ({
  usePersonalBackTarget: () => ({ to: "/bots", label: "Back to Bots" }),
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({
    data: {
      bots: [
        {
          botId: "bot-a",
          name: "Ada",
          avatarShape: "pill",
          avatarColor: "#E8711A",
          modelSelection: {},
        },
      ],
    },
  }),
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.off.clear();
  state.frames = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Probe() {
  return useChatMountAfterFirstPaint() ? <span>chat</span> : <span>shell</span>;
}

const setup = () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => state.frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
};

it("paints the shell first and mounts the chat after that paint (H8)", async () => {
  setup();
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("shell");
  await act(async () => {
    state.frames[0]!();
    vi.runAllTimers();
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("chat");
});

it("mounts the chat at once with chat-shell-first off", async () => {
  setup();
  state.off.add("chat-shell-first");
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("chat");
});

it("draws the same Back link, name and model line as the chat header", async () => {
  setup();
  await act(async () => {
    renderer = create(<ConversationShellHeader botId="bot-a" />);
  });
  const text = JSON.stringify(renderer!.toJSON());
  expect(renderer!.root.findByProps({ "aria-label": "Back to Bots" })).toBeTruthy();
  expect(text).toContain("Ada");
  expect(text).toContain("Sonnet 5.5");
});
