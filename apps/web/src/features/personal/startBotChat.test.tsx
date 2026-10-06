import type { EnvironmentId, PersonalBotId } from "@t3tools/contracts";
import { useEffect } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useStartBotChat } from "./startBotChat";

const calls = vi.hoisted(() => ({
  created: [] as unknown[],
  navigated: [] as unknown[],
  release: null as (() => void) | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => async (options: unknown) => {
    calls.navigated.push(options);
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (args: unknown) => {
    calls.created.push(args);
    await new Promise<void>((resolve) => (calls.release = resolve));
    return { _tag: "Success" };
  },
}));
vi.mock("./usePersonalBots", () => ({ personalBotCreateThread: {} }));

const hook = { latest: null as unknown as ReturnType<typeof useStartBotChat> };

function Harness() {
  const chat = useStartBotChat("env" as EnvironmentId, "bot-1" as PersonalBotId);
  useEffect(() => {
    hook.latest = chat;
  });
  return null;
}

beforeEach(() => {
  calls.created = [];
  calls.navigated = [];
  calls.release = null;
});

describe("useStartBotChat", () => {
  it("makes one chat when started twice before the first has finished", async () => {
    act(() => {
      create(<Harness />);
    });
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      // Both calls see the same render: the state flag has not caught up yet.
      first = hook.latest.start();
      second = hook.latest.start();
    });
    await act(async () => {
      calls.release?.();
      await Promise.all([first, second]);
    });
    expect(calls.created).toHaveLength(1);
    expect(calls.navigated).toHaveLength(1);
  });
});
