import type { EnvironmentId, PersonalBotId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useStartBotChat } from "./startBotChat";

const calls = vi.hoisted(() => ({
  created: [] as unknown[],
  navigated: [] as unknown[],
  release: null as (() => void) | null,
  result: { _tag: "Success" } as { readonly _tag: string; readonly cause?: unknown },
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
    return calls.result;
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
  calls.result = { _tag: "Success" };
});

describe("useStartBotChat", () => {
  it("makes one chat when started twice before the first has finished", async () => {
    act(() => {
      create(<Harness />);
    });
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
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

  it("creates the chat with the name the owner typed", async () => {
    act(() => {
      create(<Harness />);
    });
    let started!: Promise<unknown>;
    act(() => {
      started = hook.latest.start({ title: "Main" });
    });
    await act(async () => {
      calls.release?.();
      await started;
    });
    expect(calls.created).toEqual([
      {
        environmentId: "env",
        input: { botId: "bot-1", threadId: expect.any(String), title: "Main" },
      },
    ]);
    expect(calls.navigated).toHaveLength(1);
  });

  it("does not open the chat when the name is refused, and says why", async () => {
    calls.result = {
      _tag: "Failure",
      cause: Cause.fail({
        message: 'A chat called "Main" already exists',
        code: "chat_name_taken",
      }),
    };
    act(() => {
      create(<Harness />);
    });
    let started!: Promise<unknown>;
    act(() => {
      started = hook.latest.start({ title: "Main" });
    });
    let outcome: unknown;
    await act(async () => {
      calls.release?.();
      outcome = await started;
    });
    expect(outcome).toEqual({
      ok: false,
      message: 'A chat called "Main" already exists',
      nameTaken: true,
    });
    expect(calls.navigated).toHaveLength(0);
  });
});
