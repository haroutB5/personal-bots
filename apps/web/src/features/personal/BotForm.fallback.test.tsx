import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
  ProviderDriverKind,
  type PersonalBot,
  type ServerProvider,
} from "@t3tools/contracts";
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

describe("BotForm usage-limit fallback", () => {
  it("shows the fallback on by default with Sonnet 5.5, high, 1M", async () => {
    const tree = await render(null);
    const group = tree.root.findByProps({ "data-testid": "bot-fallback" });
    expect(group.props["aria-label"]).toBe("Usage limit fallback");
    const toggle = tree.root.findAll(
      (node) => node.props?.role === "switch" && typeof node.type === "string",
    )[0]!;
    expect(toggle.props.checked).toBe(true);
    expect(byId(tree, "bot-fallback-model")?.props.value).toBe("claude-sonnet-5-5");
    expect(byId(tree, "bot-fallback-effort")?.props.value).toBe("high");
    expect(byId(tree, "bot-fallback-context-window")?.props.value).toBe("1m");
  });

  it("sends the whole fallback on create", async () => {
    const tree = await render(null);
    await act(async () => byId(tree, "bot-name")!.props.onChange({ target: { value: "Scout" } }));
    await submit(tree);
    expect(state.calls.length).toBe(1);
    const input = (state.calls[0]!.target as { input: Record<string, unknown> }).input;
    expect(state.calls[0]!.command).toBe("create");
    expect(input.fallback).toEqual({
      enabled: true,
      modelSelection: PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
    });
  });

  it("sends no fallback for an edit that leaves it alone", async () => {
    const tree = await render(savedBot());
    await submit(tree);
    const input = (state.calls[0]!.target as { input: Record<string, unknown> }).input;
    expect(state.calls[0]!.command).toBe("update");
    expect("fallback" in input).toBe(false);
  });

  it("sends only the switch when the owner turns the fallback off", async () => {
    const tree = await render(savedBot());
    const toggle = tree.root.findAll(
      (node) => node.props?.role === "switch" && typeof node.type === "string",
    )[0]!;
    await act(async () => toggle.props.onChange({ target: { checked: false } }));
    expect(byId(tree, "bot-fallback-model")).toBeUndefined();
    await submit(tree);
    const input = (state.calls[0]!.target as { input: Record<string, unknown> }).input;
    expect(input.fallback).toEqual({ enabled: false });
  });

  it("sends the new model when the owner changes the fallback effort", async () => {
    const tree = await render(savedBot());
    await act(async () =>
      byId(tree, "bot-fallback-effort")!.props.onChange({ target: { value: "medium" } }),
    );
    await submit(tree);
    const input = (state.calls[0]!.target as { input: Record<string, unknown> }).input;
    expect(input.fallback).toEqual({
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-sonnet-5-5",
        options: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "1m" },
        ],
      },
    });
  });

  it("hints, without blocking, when the fallback is the main model's family", async () => {
    const tree = await render(
      savedBot({
        modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } as never,
      }),
    );
    const hint = tree.root.findByProps({ "data-testid": "bot-fallback-same-family" });
    expect(hint.props.children).toBe(
      "Same provider as the main model: it only helps for a model-specific limit.",
    );
    await submit(tree);
    expect(state.calls.length).toBe(1);
  });

  it("shows no hint for a different model family", async () => {
    const tree = await render(savedBot());
    expect(tree.root.findAllByProps({ "data-testid": "bot-fallback-same-family" })).toEqual([]);
  });
});
