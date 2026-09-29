import type { ReactTestInstance } from "react-test-renderer";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { NewTeamForm } from "./NewTeamForm";

interface Call {
  readonly command: string;
  readonly input: Record<string, unknown>;
}

const state = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; input: Record<string, unknown> }>,
  failUpdateFor: null as string | null,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("~/state/server", () => ({ primaryServerProvidersAtom: {} }));
vi.mock("./usePersonalBots", () => ({
  personalProfileSet: "profile",
  personalBotUpdate: "update",
}));
vi.mock("./PersonalOfflineBanner", () => ({ useLaptopOffline: () => false }));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => null }));
vi.mock("./commandFeedback", () => ({
  commandFailureMessage: (result: { _tag: string; message?: string }, fallback: string) =>
    result._tag === "Success" ? null : (result.message ?? fallback),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => async (target: { input: Record<string, unknown> }) => {
    state.calls.push({ command, input: target.input });
    if (command === "update" && target.input.botId === state.failUpdateFor) {
      return { _tag: "Failure", message: "The bot is busy." };
    }
    return { _tag: "Success", value: {} };
  },
}));

const bot = (id: string, name: string, extra: { team?: string; lead?: boolean } = {}): never =>
  ({
    botId: id,
    name,
    title: "",
    avatarShape: "circle",
    avatarColor: "blue",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    ...extra,
  }) as never;

const BOTS = [
  bot("cto", "CTO", { team: "dev", lead: true }),
  bot("ada", "Ada", { team: "assistant" }),
  bot("qa", "QA", { team: "dev" }),
];

let renderer: ReactTestRenderer | undefined;
const created: unknown[] = [];

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.calls = [];
  state.failUpdateFor = null;
  created.length = 0;
  vi.unstubAllGlobals();
});

const render = async (customTeams: ReadonlyArray<string> = []) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <NewTeamForm
        environmentId={"env-1" as never}
        bots={BOTS}
        customTeams={customTeams}
        onCreated={(notice) => created.push(notice)}
      />,
    );
  });
  if (renderer === undefined) throw new Error("render failed");
  return renderer;
};

const nameField = (tree: ReactTestRenderer) =>
  tree.root.findAllByType("input").find((node) => String(node.props.id).endsWith("-name"))!;

const typeName = async (tree: ReactTestRenderer, value: string) =>
  act(async () => nameField(tree).props.onChange({ target: { value } }));

const radios = (tree: ReactTestRenderer) =>
  tree.root.findAllByType("input").filter((node) => node.props.type === "radio");

/** The radio inside the row that shows this bot's name. */
const leaderRadio = (tree: ReactTestRenderer, botName: string) => {
  const rows = tree.root.findAllByType("label");
  const row = rows.find(
    (label) =>
      label.findAllByType("input").some((node) => node.props.type === "radio") &&
      text(label).includes(botName),
  );
  return row!.findAllByType("input")[0]!;
};

const memberBox = (tree: ReactTestRenderer, botName: string) => {
  const row = tree.root
    .findAllByType("label")
    .find(
      (label) =>
        label.findAllByType("input").some((node) => node.props.type === "checkbox") &&
        text(label).includes(botName),
    );
  return row!.findAllByType("input")[0]!;
};

const submit = async (tree: ReactTestRenderer) =>
  act(async () => tree.root.findByType("form").props.onSubmit({ preventDefault: () => {} }));

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");

const buttons = (tree: ReactTestRenderer) => tree.root.findAllByType("button");
const buttonWithText = (tree: ReactTestRenderer, fragment: string) =>
  buttons(tree).find((button) => text(button).includes(fragment));

const roleText = (tree: ReactTestRenderer, role: string) =>
  tree.root
    .findAll((node) => typeof node.type === "string" && node.props?.role === role)
    .map(text)
    .join(" ");

const commands = (): ReadonlyArray<Call> => state.calls;

describe("NewTeamForm", () => {
  it("shows each bot with its model label and a No leader choice picked first", async () => {
    const tree = await render();
    const rows = tree.root.findAllByType("label").map(text);
    expect(rows.some((row) => row.includes("No leader for now"))).toBe(true);
    // The model as the Bots list names it (the id here, as no provider is listed).
    expect(rows.some((row) => row.includes("CTO") && row.includes("claude-opus-5-5"))).toBe(true);
    expect(radios(tree).filter((node) => node.props.checked)).toHaveLength(1);
    expect(radios(tree)[0]!.props.checked).toBe(true);
  });

  it("creates a team with no lead: only the team is registered", async () => {
    const tree = await render();
    await typeName(tree, "  Research ");
    await submit(tree);

    expect(commands()).toEqual([
      {
        command: "profile",
        input: { teamChange: { operation: "create", name: "Research" } },
      },
    ]);
    expect(created).toEqual([
      { team: "Research", message: "Team Research created. It has no lead yet." },
    ]);
  });

  it("creates a team with a lead taken from no team (a plain member)", async () => {
    const tree = await render();
    await typeName(tree, "Research");
    await act(async () => leaderRadio(tree, "Ada").props.onChange());
    // Nothing is left behind, so no warning and no confirm step.
    expect(roleText(tree, "status")).toBe("");
    await submit(tree);

    expect(commands().map((call) => call.command)).toEqual(["profile", "update"]);
    expect(commands()[1]!.input).toEqual({ botId: "ada", team: "Research", lead: true });
    expect(created).toEqual([
      { team: "Research", message: "Team Research created. Ada leads it." },
    ]);
  });

  it("warns and asks to confirm before taking a lead from another team", async () => {
    const tree = await render();
    await typeName(tree, "Research");
    await act(async () => leaderRadio(tree, "CTO").props.onChange());

    expect(roleText(tree, "status")).toBe(
      "CTO leads Dev team; it will move to Research, and Dev team will have no lead.",
    );

    await submit(tree);
    // Asked, not done: nothing has been sent.
    expect(commands()).toEqual([]);
    expect(created).toEqual([]);
    expect(
      tree.root.findAll((node) => node.props?.["aria-label"] === "Confirm the move"),
    ).not.toHaveLength(0);

    // The confirm says the whole of it, so nothing hides behind the bar.
    expect(
      text(tree.root.findAll((node) => node.props?.["aria-label"] === "Confirm the move")[0]!),
    ).toContain("CTO leads Dev team; it will move to Research, and Dev team will have no lead.");

    await act(async () => buttonWithText(tree, "Move CTO and create team")!.props.onClick());
    expect(commands().map((call) => call.command)).toEqual(["profile", "update"]);
    expect(commands()[1]!.input).toEqual({ botId: "cto", team: "Research", lead: true });
    expect(created).toHaveLength(1);
  });

  it("backing out of the confirm sends nothing", async () => {
    const tree = await render();
    await typeName(tree, "Research");
    await act(async () => leaderRadio(tree, "CTO").props.onChange());
    await submit(tree);
    await act(async () => buttonWithText(tree, "Back")!.props.onClick());
    expect(commands()).toEqual([]);
    expect(buttonWithText(tree, "Move CTO")).toBeUndefined();
  });

  it("refuses a duplicate name, whatever the case, without sending anything", async () => {
    const tree = await render(["Research"]);
    await typeName(tree, "research");
    await submit(tree);

    expect(commands()).toEqual([]);
    expect(created).toEqual([]);
    expect(nameField(tree).props["aria-invalid"]).toBe(true);
    expect(tree.root.findAllByType("p").map(text).join(" ")).toContain(
      "There is already a team called Research.",
    );

    // Built-ins too, by label.
    await typeName(tree, "dev team");
    await submit(tree);
    expect(commands()).toEqual([]);
    expect(tree.root.findAllByType("p").map(text).join(" ")).toContain("Dev team");
  });

  it("moves members in as plain members, and a member that led a team stops leading", async () => {
    const tree = await render();
    await typeName(tree, "Research");
    await act(async () => leaderRadio(tree, "Ada").props.onChange());
    await act(async () => memberBox(tree, "CTO").props.onChange());
    await act(async () => memberBox(tree, "QA").props.onChange());
    // The member that leads Dev is named too.
    expect(roleText(tree, "status")).toContain("CTO leads Dev team");

    await submit(tree);
    await act(async () => buttonWithText(tree, "Move CTO and create team")!.props.onClick());

    expect(commands().map((call) => call.input)).toEqual([
      { teamChange: { operation: "create", name: "Research" } },
      { botId: "ada", team: "Research", lead: true },
      { botId: "cto", team: "Research", lead: false },
      { botId: "qa", team: "Research", lead: false },
    ]);
    expect(created).toEqual([
      { team: "Research", message: "Team Research created. Ada leads it. 2 bots moved in." },
    ]);
  });

  it("after a failed move, says so and a retry does not register the team again", async () => {
    state.failUpdateFor = "ada";
    const tree = await render();
    await typeName(tree, "Research");
    await act(async () => leaderRadio(tree, "Ada").props.onChange());
    await submit(tree);

    expect(created).toEqual([]);
    expect(roleText(tree, "alert")).toBe(
      "Research was created, but Ada couldn't be moved: The bot is busy.",
    );
    expect(nameField(tree).props.disabled).toBe(true);

    state.failUpdateFor = null;
    await submit(tree);
    expect(commands().map((call) => call.command)).toEqual(["profile", "update", "update"]);
    expect(created).toHaveLength(1);
  });
});
