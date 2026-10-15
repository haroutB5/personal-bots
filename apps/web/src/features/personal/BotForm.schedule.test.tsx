import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ProviderDriverKind, type PersonalBot, type ServerProvider } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { EditBotScreen, NewBotScreen } from "./BotForm";

const select = (id: string, values: ReadonlyArray<string>) => ({
  id,
  label: id,
  type: "select" as const,
  options: values.map((value) => ({ id: value, label: value })),
});

const state = vi.hoisted(() => ({
  providers: [] as unknown[],
  bots: [] as unknown[],
  calls: [] as Array<{ readonly command: string; readonly target: unknown }>,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => async () => {},
  useBlocker: () => {},
  useLocation: () => ({}),
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: async () => true }));
vi.mock("~/state/server", () => ({ primaryServerProvidersAtom: {} }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => async (target: unknown) => {
    state.calls.push({ command, target });
    return { _tag: "Success", value: {} };
  },
}));
vi.mock("./usePersonalBots", () => ({
  personalBotCreate: "create",
  personalBotUpdate: "update",
  usePersonalBotsList: () => ({ data: { bots: state.bots } }),
  usePersonalEnvironmentId: () => "env-1",
  usePersonalProfile: () => ({ data: { customTeams: [] } }),
}));
vi.mock("./usePersonalGroups", () => ({ personalGroupAddMember: "add" }));
vi.mock("./useDeleteBot", () => ({ useDeleteBot: () => async () => ({ status: "cancelled" }) }));
vi.mock("./usePersonalBackTarget", () => ({
  usePersonalBackTarget: () => ({ to: "/bots", label: "Back to Bots" }),
}));
vi.mock("./BotAvatarPicker", () => ({ BotAvatarPicker: () => null }));

const model = (slug: string, optionDescriptors: ReadonlyArray<ReturnType<typeof select>> = []) => ({
  slug,
  name: slug,
  isCustom: false,
  isDefault: slug === "claude-opus-5-5",
  capabilities: createModelCapabilities({ optionDescriptors }),
});

const claude = {
  instanceId: "claudeAgent",
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [
    model("claude-opus-5-5", [select("effort", ["low", "high"])]),
    model("claude-sonnet-5-5", [
      select("effort", ["low", "medium", "high"]),
      select("contextWindow", ["200k", "1m"]),
    ]),
  ],
} as unknown as ServerProvider;

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.calls = [];
  vi.unstubAllGlobals();
});

const render = async (bot: PersonalBot | null) => {
  state.providers = [claude];
  state.bots = bot === null ? [] : [bot];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(bot === null ? <NewBotScreen /> : <EditBotScreen botId="bot-1" />);
  });
  if (renderer === undefined) throw new Error("render failed");
  return renderer;
};

const byId = (tree: ReactTestRenderer, id: string) =>
  tree.root.findAll((node) => node.props?.id === id && typeof node.type === "string")[0];

const submit = async (tree: ReactTestRenderer) => {
  await act(async () => tree.root.findByType("form").props.onSubmit({ preventDefault: () => {} }));
};

const savedBot = (extra: Partial<PersonalBot> = {}): PersonalBot =>
  ({
    botId: "bot-1",
    name: "Planner",
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    ...extra,
  }) as unknown as PersonalBot;

const switches = (tree: ReactTestRenderer) =>
  tree.root.findAll((node) => node.props?.role === "switch" && typeof node.type === "string");

const inputOf = (index = 0) =>
  (state.calls[index]!.target as { input: Record<string, unknown> }).input;

const SONNET_HIGH_1M = {
  instanceId: "claudeAgent",
  model: "claude-sonnet-5-5",
  options: [
    { id: "effort", value: "high" },
    { id: "contextWindow", value: "1m" },
  ],
};

describe("BotForm model schedule", () => {
  it("sits after the usage-limit fallback, off by default, with nothing sent for a bot that leaves it", async () => {
    const tree = await render(savedBot());
    const group = tree.root.findByProps({ "data-testid": "bot-schedule" });
    expect(group.props["aria-label"]).toBe("Model schedule");
    // The fallback's switch stays the first one; the schedule's is the second.
    expect(switches(tree)).toHaveLength(2);
    expect(switches(tree)[0]!.props.checked).toBe(true);
    expect(switches(tree)[1]!.props.checked).toBe(false);
    expect(byId(tree, "bot-schedule-from")).toBeUndefined();
    await submit(tree);
    expect("schedule" in inputOf()).toBe(false);
  });

  it("shows From, To and the model when turned on, with one line for the result", async () => {
    const tree = await render(savedBot());
    await act(async () => switches(tree)[1]!.props.onChange({ target: { checked: true } }));
    expect(byId(tree, "bot-schedule-from")?.props.value).toBe("22:00");
    expect(byId(tree, "bot-schedule-to")?.props.value).toBe("07:00");
    expect(byId(tree, "bot-schedule-model")?.props.value).toBe("claude-sonnet-5-5");
    expect(byId(tree, "bot-schedule-effort")?.props.value).toBe("high");
    const times = byId(tree, "bot-schedule-from")!.findAllByType("option");
    expect(times).toHaveLength(96);
    expect(times[0]!.props.value).toBe("00:00");
    expect(times[95]!.props.value).toBe("23:45");
    const summary = tree.root.findByProps({ "data-testid": "bot-schedule-summary" });
    expect(String(summary.props.children)).toContain("Every day 22:00 to 07:00 this bot uses");
  });

  it("sends the whole schedule when an edit turns it on, next to an untouched fallback", async () => {
    const tree = await render(savedBot());
    await act(async () => switches(tree)[1]!.props.onChange({ target: { checked: true } }));
    await act(async () =>
      byId(tree, "bot-schedule-from")!.props.onChange({ target: { value: "23:15" } }),
    );
    await submit(tree);
    expect(state.calls[0]!.command).toBe("update");
    expect(inputOf().schedule).toEqual({
      enabled: true,
      from: "23:15",
      to: "07:00",
      modelSelection: SONNET_HIGH_1M,
    });
    expect("fallback" in inputOf()).toBe(false);
  });

  it("sends the whole schedule on create, and nothing when it stays off", async () => {
    const on = await render(null);
    await act(async () => byId(on, "bot-name")!.props.onChange({ target: { value: "Scout" } }));
    await act(async () => switches(on)[1]!.props.onChange({ target: { checked: true } }));
    await submit(on);
    expect(state.calls[0]!.command).toBe("create");
    expect(inputOf().schedule).toEqual({
      enabled: true,
      from: "22:00",
      to: "07:00",
      modelSelection: SONNET_HIGH_1M,
    });
    await act(async () => on.unmount());
    renderer = undefined;
    state.calls = [];

    const off = await render(null);
    await act(async () => byId(off, "bot-name")!.props.onChange({ target: { value: "Scout" } }));
    await submit(off);
    expect("schedule" in inputOf()).toBe(false);
  });

  it("refuses From = To in plain words and does not save", async () => {
    const tree = await render(savedBot());
    await act(async () => switches(tree)[1]!.props.onChange({ target: { checked: true } }));
    await act(async () =>
      byId(tree, "bot-schedule-to")!.props.onChange({ target: { value: "22:00" } }),
    );
    const problem = tree.root.findByProps({ "data-testid": "bot-schedule-problem" });
    expect(problem.props.children).toBe("From and To can't be the same time.");
    expect(tree.root.findAllByProps({ "data-testid": "bot-schedule-summary" })).toHaveLength(0);
    await submit(tree);
    expect(state.calls).toHaveLength(0);
    // Fixing it clears the message and saves.
    await act(async () =>
      byId(tree, "bot-schedule-to")!.props.onChange({ target: { value: "06:00" } }),
    );
    await submit(tree);
    expect(state.calls).toHaveLength(1);
  });

  it("refuses the bot's own model, and accepts the same model at another effort", async () => {
    const tree = await render(
      savedBot({
        modelSelection: {
          instanceId: "claudeAgent",
          model: "claude-sonnet-5-5",
          options: [{ id: "effort", value: "high" }],
        } as never,
      }),
    );
    await act(async () => switches(tree)[1]!.props.onChange({ target: { checked: true } }));
    // The scheduled model starts as Sonnet 5.5 High: the bot's own.
    expect(tree.root.findByProps({ "data-testid": "bot-schedule-problem" }).props.children).toBe(
      "Pick a different model from the bot's own, or a different effort.",
    );
    await submit(tree);
    expect(state.calls).toHaveLength(0);
    await act(async () =>
      byId(tree, "bot-schedule-effort")!.props.onChange({ target: { value: "low" } }),
    );
    expect(tree.root.findAllByProps({ "data-testid": "bot-schedule-problem" })).toHaveLength(0);
    await submit(tree);
    expect(inputOf().schedule).toMatchObject({
      enabled: true,
      modelSelection: { model: "claude-sonnet-5-5" },
    });
  });

  it("loads a saved schedule, sends only what changed, and only the switch when it is turned off", async () => {
    const saved = {
      enabled: true,
      from: "21:00",
      to: "06:00",
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "low" }],
      },
    };
    const tree = await render(
      savedBot({
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } as never,
        schedule: saved as never,
      }),
    );
    expect(switches(tree)[1]!.props.checked).toBe(true);
    expect(byId(tree, "bot-schedule-from")?.props.value).toBe("21:00");
    expect(byId(tree, "bot-schedule-to")?.props.value).toBe("06:00");
    expect(byId(tree, "bot-schedule-model")?.props.value).toBe("claude-opus-5-5");
    await act(async () =>
      byId(tree, "bot-schedule-to")!.props.onChange({ target: { value: "06:30" } }),
    );
    await submit(tree);
    expect(inputOf().schedule).toEqual({ to: "06:30" });
    await act(async () => tree.unmount());
    renderer = undefined;
    state.calls = [];

    const again = await render(
      savedBot({
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } as never,
        schedule: saved as never,
      }),
    );
    await act(async () => switches(again)[1]!.props.onChange({ target: { checked: false } }));
    expect(byId(again, "bot-schedule-from")).toBeUndefined();
    await submit(again);
    expect(inputOf().schedule).toEqual({ enabled: false });
  });

  it("keeps a saved time that is off the 15-minute grid selectable", async () => {
    const tree = await render(
      savedBot({
        schedule: {
          enabled: true,
          from: "22:10",
          to: "07:00",
          modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
        } as never,
      }),
    );
    const from = byId(tree, "bot-schedule-from")!;
    expect(from.props.value).toBe("22:10");
    expect(from.findAllByType("option").map((option) => option.props.value)).toContain("22:10");
  });

  it("saves the fallback and the schedule together", async () => {
    const tree = await render(savedBot());
    await act(async () => switches(tree)[0]!.props.onChange({ target: { checked: false } }));
    await act(async () => switches(tree)[1]!.props.onChange({ target: { checked: true } }));
    await submit(tree);
    expect(inputOf().fallback).toEqual({ enabled: false });
    expect(inputOf().schedule).toMatchObject({ enabled: true, from: "22:00", to: "07:00" });
  });
});
