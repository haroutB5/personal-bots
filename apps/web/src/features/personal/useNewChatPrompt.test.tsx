import type { EnvironmentId, PersonalBotId } from "@t3tools/contracts";
import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useNewChatPrompt, type NewChatPromptOptions } from "./useNewChatPrompt";

interface DialogProps {
  readonly open: boolean;
  readonly botName: string;
  readonly starting: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStart: (title: string) => void;
}

const log = vi.hoisted(() => ({
  events: [] as string[],
  startCalls: [] as unknown[],
  release: null as (() => void) | null,
  hold: false,
  dialogProps: null as unknown,
}));

vi.mock("./NewChatDialog", () => ({
  NewChatDialog: (props: unknown) => {
    log.dialogProps = props;
    return <div data-dialog="" />;
  },
}));
vi.mock("./renameChat", async (importActual) => ({
  ...(await importActual<typeof import("./renameChat")>()),
  useRenameChat: () => async (threadId: string, title: string) => {
    log.events.push(`rename ${threadId} ${title}`);
    return null;
  },
}));
vi.mock("./startBotChat", () => ({
  // The real hook creates the thread, runs onCreated, then navigates.
  useStartBotChat: () => ({
    starting: false,
    start: async (options?: { onCreated?: (threadId: string) => Promise<unknown> }) => {
      log.startCalls.push(options);
      log.events.push("create");
      if (log.hold) await new Promise<void>((resolve) => (log.release = resolve));
      await options?.onCreated?.("new-thread");
      log.events.push("navigate");
    },
  }),
}));

const ENV = "env" as EnvironmentId;
const BOT = { botId: "bot-1" as PersonalBotId, name: "Frontend" };

const hook = { latest: null as unknown as ReturnType<typeof useNewChatPrompt> };
let renderer: ReactTestRenderer;

function Harness({ bot }: { bot: typeof BOT | null }) {
  const prompt = useNewChatPrompt(ENV, bot);
  useEffect(() => {
    hook.latest = prompt;
  });
  return prompt.dialog;
}

const dialog = () => log.dialogProps as DialogProps;
const mounted = () => renderer.root.findAllByProps({ "data-dialog": "" }).length === 1;

function render(bot: typeof BOT | null = BOT) {
  act(() => {
    renderer = create(<Harness bot={bot} />);
  });
}

function open(options?: NewChatPromptOptions) {
  act(() => hook.latest.open(options));
}

beforeEach(() => {
  log.events = [];
  log.startCalls = [];
  log.release = null;
  log.hold = false;
  log.dialogProps = null;
});

describe("useNewChatPrompt", () => {
  it("shows nothing until a New chat button asks for the name sheet", () => {
    render();
    expect(mounted()).toBe(false);
    open();
    expect(mounted()).toBe(true);
    expect(dialog().open).toBe(true);
    expect(dialog().botName).toBe("Frontend");
    expect(log.startCalls).toHaveLength(0);
  });

  it("names the chat before it opens when a name was typed", async () => {
    render();
    open();
    await act(async () => dialog().onStart("  Plan B  "));
    expect(log.events).toEqual(["create", "rename new-thread Plan B", "navigate"]);
    // The sheet is gone once the chat is on its way.
    expect(mounted()).toBe(false);
  });

  it("keeps the auto-title when the name is empty", async () => {
    render();
    open();
    await act(async () => dialog().onStart("   "));
    expect(log.events).toEqual(["create", "navigate"]);
    expect(log.startCalls).toEqual([{}]);
  });

  it("creates nothing on Cancel, Escape or a tap outside", () => {
    render();
    open();
    act(() => dialog().onOpenChange(false));
    expect(dialog().open).toBe(false);
    expect(log.startCalls).toHaveLength(0);
    expect(log.events).toEqual([]);
  });

  it("gives every opening a fresh sheet and its own navigation options", async () => {
    render();
    const before = vi.fn();
    open({ replace: true, keepState: true, onBeforeStart: before });
    await act(async () => dialog().onStart(""));
    expect(before).toHaveBeenCalledTimes(1);
    expect(log.startCalls[0]).toEqual({ replace: true, keepState: true });

    // The "..." menu opens it again with no options: a plain push, no hand-off.
    open();
    expect(dialog().open).toBe(true);
    await act(async () => dialog().onStart(""));
    expect(before).toHaveBeenCalledTimes(1);
    expect(log.startCalls[1]).toEqual({});
  });

  it("starts one chat when Start chat is pressed twice", async () => {
    render();
    open();
    log.hold = true;
    act(() => {
      dialog().onStart("Twice");
      dialog().onStart("Twice");
    });
    expect(log.startCalls).toHaveLength(1);
    await act(async () => {
      log.release?.();
    });
    expect(log.events.filter((event) => event === "create")).toHaveLength(1);
    expect(log.events.filter((event) => event.startsWith("rename"))).toHaveLength(1);
  });

  it("does nothing without a bot", () => {
    render(null);
    open();
    expect(mounted()).toBe(false);
  });
});
