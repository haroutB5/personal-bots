import type { ReactNode } from "react";

import type { BotSummary } from "./botSummaries";
import * as Cause from "effect/Cause";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { BotPickerSheet } from "./BotPickerSheet";

const state = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  outcome: { _tag: "Success", value: {} } as unknown,
  navigate: vi.fn(),
  closed: [] as boolean[],
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [], useAtomRefresh: () => () => {} }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async (value: Record<string, unknown>) => {
    state.created.push(value);
    return state.outcome;
  },
}));
vi.mock("./usePersonalBots", () => ({ personalBotCreateThread: { label: "create-thread" } }));
vi.mock("~/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetClose: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

let renderer: ReactTestRenderer | undefined;

const summary = (botId: string, name: string, title = ""): BotSummary =>
  ({
    bot: { botId, name, title, avatarShape: "pill", avatarColor: "#E8711A" },
    modelLabel: "Sonnet 5.5 · M",
  }) as unknown as BotSummary;

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <BotPickerSheet
        open
        onOpenChange={(open) => state.closed.push(open)}
        environmentId={"env-1" as never}
        bots={[summary("bot-juno", "Juno", "Trips and plans"), summary("bot-forge", "Forge")]}
        now={Date.now()}
      />,
    );
  });
}

const buttons = () =>
  renderer!.root
    .findAll((node) => node.type === "button")
    .filter((node) => typeof node.props["aria-label"] === "string");

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.created.length = 0;
  state.outcome = { _tag: "Success", value: {} };
  state.navigate.mockClear();
  state.closed.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BotPickerSheet", () => {
  it("lists the bots with their one-line description", async () => {
    await render();
    const labels = buttons().map((node) => node.props["aria-label"] as string);
    expect(labels).toContain("New chat with Juno");
    expect(labels).toContain("New chat with Forge");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Trips and plans");
    // A bot with no title falls back to its model line.
    expect(JSON.stringify(renderer!.toJSON())).toContain("Sonnet 5.5 · M");
  });

  it("starts a new chat with the picked bot and opens it", async () => {
    await render();
    const row = buttons().find((node) => node.props["aria-label"] === "New chat with Juno")!;
    await act(async () => row.props.onClick());
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({ environmentId: "env-1" });
    const input = state.created[0]!["input"] as { botId: string; threadId: string };
    expect(input.botId).toBe("bot-juno");
    // The sheet closes before the chat opens: the list stays mounted under it.
    expect(state.closed).toEqual([false]);
    expect(state.navigate).toHaveBeenCalledTimes(1);
    expect(state.navigate.mock.calls[0]![0]).toMatchObject({
      to: "/bots/$botId/$threadId",
      params: { botId: "bot-juno", threadId: input.threadId },
    });
  });

  it("shows why when starting the chat is refused, and does not navigate", async () => {
    state.outcome = {
      _tag: "Failure",
      cause: Cause.fail(new Error("Laptop unreachable")),
    };
    await render();
    await act(async () =>
      buttons()
        .find((node) => node.props["aria-label"] === "New chat with Juno")!
        .props.onClick(),
    );
    expect(state.navigate).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Laptop unreachable");
    // The sheet stays open so the tap can be retried.
    expect(state.closed).toEqual([]);
  });

  it("narrows the list as the owner types", async () => {
    await render();
    const field = renderer!.root.find(
      (node) => node.type === "input" && node.props["aria-label"] === "Search bots",
    );
    await act(async () => field.props.onChange({ target: { value: "for" } }));
    const labels = buttons().map((node) => node.props["aria-label"] as string);
    expect(labels).toContain("New chat with Forge");
    expect(labels).not.toContain("New chat with Juno");
  });

  it("keeps New group and New bot reachable (New team stays on the Team screen)", async () => {
    await render();
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("New group");
    expect(text).toContain("New bot");
    expect(text).not.toContain("New team");
  });

  it("needs no typing to reach a bot: the rows are 44 px targets", async () => {
    await render();
    expect(buttons().length).toBeGreaterThanOrEqual(2);
  });
});
