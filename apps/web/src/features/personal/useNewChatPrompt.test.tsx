import type { EnvironmentId, PersonalBotId } from "@t3tools/contracts";
import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useNewChatPrompt, type NewChatPromptOptions } from "./useNewChatPrompt";

interface DialogProps {
  readonly open: boolean;
  readonly botId: string;
  readonly botName: string;
  readonly starting: boolean;
  readonly error: string | null;
  readonly onDraftChange: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStart: (title: string) => void;
}

const log = vi.hoisted(() => ({
  events: [] as string[],
  startCalls: [] as unknown[],
  release: null as (() => void) | null,
  hold: false,
  refuse: null as string | null,
  dialogProps: null as unknown,
}));

vi.mock("./NewChatDialog", () => ({
  NewChatDialog: (props: unknown) => {
    log.dialogProps = props;
    return <div data-dialog="" />;
  },
}));
vi.mock("./startBotChat", () => ({
  // The real hook creates the thread (already named), then navigates.
  useStartBotChat: () => ({
    starting: false,
    start: async (options?: { title?: string }) => {
      log.startCalls.push(options);
      log.events.push(options?.title === undefined ? "create" : `create ${options.title}`);
      if (log.hold) await new Promise<void>((resolve) => (log.release = resolve));
      if (log.refuse !== null) {
        return { ok: false as const, message: log.refuse, nameTaken: true };
      }
      log.events.push("navigate");
      return { ok: true as const };
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
  log.refuse = null;
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

  it("creates the chat with the name that was typed, so it never shows New chat", async () => {
    render();
    open();
    await act(async () => dialog().onStart("  Plan B  "));
    expect(log.events).toEqual(["create Plan B", "navigate"]);
    // The sheet is gone once the chat is on its way.
    expect(mounted()).toBe(false);
  });

  it("keeps the sheet open with the reason when the server refuses the name", async () => {
    render();
    open();
    log.refuse = 'A chat called "Plan B" already exists';
    await act(async () => dialog().onStart("Plan B"));
    expect(log.events).toEqual(["create Plan B"]);
    expect(mounted()).toBe(true);
    expect(dialog().open).toBe(true);
    expect(dialog().error).toBe('A chat called "Plan B" already exists');
    // Changing the name clears the reason; a free name then opens the chat.
    act(() => dialog().onDraftChange());
    expect(dialog().error).toBeNull();
    log.refuse = null;
    await act(async () => dialog().onStart("Plan C"));
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
    expect(log.events.filter((event) => event.startsWith("create"))).toHaveLength(1);
  });

  it("does nothing without a bot", () => {
    render(null);
    open();
    expect(mounted()).toBe(false);
  });
});
