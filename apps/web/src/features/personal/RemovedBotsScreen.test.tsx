import * as DateTime from "effect/DateTime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RemovedBotsScreen } from "./RemovedBotsScreen";

type Outcome =
  | {
      status: "restored";
      result: { bot: { name: string; team: string }; renamedFrom: string | null };
    }
  | { status: "failed"; message: string };

const state = vi.hoisted(() => ({
  /** One object per list, as the real query hands out: a fresh one every render would loop. */
  data: null as { bots: unknown[] } | null,
  restore: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("./usePersonalBots", () => ({ usePersonalEnvironmentId: () => "env-1" }));
vi.mock("./useMinuteNow", () => ({ useMinuteNow: () => Date.parse("2026-09-13T20:40:00Z") }));
vi.mock("./useRemovedBots", () => ({
  useRemovedBots: () => ({
    data: state.data,
    error: null,
    refresh: () => undefined,
  }),
  useRestoreRemovedBot: () => state.restore,
}));

const bot = (overrides: Record<string, unknown> = {}) => ({
  botId: "bot-1",
  name: "Analyst",
  title: "",
  team: "dev",
  avatarShape: "blob",
  avatarColor: "#1A73E8",
  modelLabel: "Sonnet 5.5 · H",
  removedAt: DateTime.makeUnsafe("2026-09-10T10:00:00.000Z"),
  removedBy: "CFO",
  reason: null,
  chats: 3,
  ...overrides,
});

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.data = null;
  state.restore.mockReset();
  vi.unstubAllGlobals();
});

const renderScreen = async (bots: unknown[]) => {
  state.data = { bots };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<RemovedBotsScreen />);
  });
};

const text = () => JSON.stringify(renderer!.toJSON());
const restoreButton = () =>
  renderer!.root.findAll(
    (node) => node.type === "button" && String(node.props["aria-label"] ?? "").includes("Restor"),
  )[0]!;

describe("Removed bots screen", () => {
  it("has a Back to Settings link and the title", async () => {
    await renderScreen([bot()]);
    expect(renderer!.root.findByProps({ "aria-label": "Back to Settings" }).props.to).toBe(
      "/bots/settings",
    );
    expect(renderer!.root.findByType("h1").props.children).toBe("Removed bots");
  });

  it("shows each bot's details", async () => {
    await renderScreen([bot({ reason: "Duplicate of the CTO helper" })]);
    const copy = text();
    for (const expected of [
      "Analyst",
      "Dev team · Sonnet 5.5 · H",
      "Removed by CFO on 10 Sep",
      "Duplicate of the CTO helper",
      "3 chats kept",
    ]) {
      expect(copy).toContain(expected);
    }
    expect(copy).toContain("Reason: ");
    expect(restoreButton().props.disabled).toBe(false);
  });

  it("leaves out the reason line when there is none", async () => {
    await renderScreen([bot()]);
    expect(text()).not.toContain("Reason");
  });

  it("says so when nothing is removed", async () => {
    await renderScreen([]);
    expect(text()).toContain("No removed bots");
    expect(renderer!.root.findAllByType("li")).toHaveLength(0);
  });

  it("restores with the bot id and confirms where it went", async () => {
    state.restore.mockResolvedValue({
      status: "restored",
      result: { bot: { name: "Analyst", team: "dev" }, renamedFrom: null },
    } satisfies Outcome);
    await renderScreen([bot()]);
    await act(async () => restoreButton().props.onClick());
    expect(state.restore).toHaveBeenCalledWith("bot-1");
    expect(text()).toContain("Analyst restored to Dev team");
    expect(text()).not.toContain("3 chats kept");
  });

  it("keeps the confirmation after the list refresh drops the bot", async () => {
    state.restore.mockResolvedValue({
      status: "restored",
      result: { bot: { name: "Analyst", team: "dev" }, renamedFrom: null },
    } satisfies Outcome);
    await renderScreen([bot(), bot({ botId: "bot-2", name: "Scout" })]);
    await act(async () => restoreButton().props.onClick());
    state.data = { bots: [bot({ botId: "bot-2", name: "Scout" })] };
    await act(async () => renderer!.update(<RemovedBotsScreen />));
    expect(text()).toContain("Analyst restored to Dev team");
    expect(text()).toContain("Scout");
  });

  it("names the new name when the old one was taken", async () => {
    state.restore.mockResolvedValue({
      status: "restored",
      result: { bot: { name: "Analyst 2", team: "dev" }, renamedFrom: "Analyst" },
    } satisfies Outcome);
    await renderScreen([bot()]);
    await act(async () => restoreButton().props.onClick());
    expect(text()).toContain("Restored as Analyst 2 (the name Analyst was taken)");
  });

  it("is busy while the restore is in flight", async () => {
    let finish: (outcome: Outcome) => void = () => undefined;
    state.restore.mockReturnValue(new Promise<Outcome>((resolve) => (finish = resolve)));
    await renderScreen([bot()]);
    await act(async () => {
      restoreButton().props.onClick();
    });
    expect(restoreButton().props.disabled).toBe(true);
    expect(restoreButton().props["aria-busy"]).toBe(true);
    expect(text()).toContain("Restoring…");
    // A second tap while busy does nothing.
    await act(async () => restoreButton().props.onClick());
    expect(state.restore).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: "failed", message: "nope" }));
    expect(restoreButton().props.disabled).toBe(false);
  });

  it("shows the error inline and keeps the row", async () => {
    state.restore.mockResolvedValue({
      status: "failed",
      message: "Only the owner can restore bots.",
    } satisfies Outcome);
    await renderScreen([bot()]);
    await act(async () => restoreButton().props.onClick());
    const alert = renderer!.root.findByProps({ role: "alert" });
    expect(alert.props.children).toBe("Only the owner can restore bots.");
    expect(text()).toContain("3 chats kept");
    expect(restoreButton().props.disabled).toBe(false);
  });
});
