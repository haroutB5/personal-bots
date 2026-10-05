import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { PersonalRoutine } from "@t3tools/contracts";

import { RoutineForm } from "./RoutineForm";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly target: unknown }>,
  bots: [{ botId: "bot-a", name: "Planner", sortOrder: 0 }] as Array<{
    botId: string;
    name: string;
    sortOrder: number;
  }> | null,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => async () => {},
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({
    data: state.bots === null ? null : { bots: state.bots },
  }),
}));
vi.mock("./usePersonalAutomation", () => ({
  personalRoutineCreate: "create",
  personalRoutineUpdate: "update",
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => async (target: unknown) => {
    state.calls.push({ command, target });
    return { _tag: "Success", value: {} };
  },
}));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.calls = [];
  state.bots = [{ botId: "bot-a", name: "Planner", sortOrder: 0 }];
  vi.unstubAllGlobals();
});

const renderForm = async (routine: PersonalRoutine | null = null) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<RoutineForm routine={routine} />);
  });
  if (renderer === undefined) throw new Error("render failed");
  return renderer;
};

const buttonWithText = (tree: ReactTestRenderer, text: string) =>
  tree.root
    .findAllByType("button")
    .find((node) => JSON.stringify(node.props.children ?? "").includes(text));

const fieldById = (tree: ReactTestRenderer, id: string) =>
  [...tree.root.findAllByType("input"), ...tree.root.findAllByType("textarea")].find(
    (node) => node.props.id === id,
  );

const type = async (tree: ReactTestRenderer, id: string, value: string) => {
  const field = fieldById(tree, id);
  if (field === undefined) throw new Error(`no field ${id}`);
  await act(async () => field.props.onChange({ target: { value } }));
};

const press = async (tree: ReactTestRenderer, text: string) => {
  const button = buttonWithText(tree, text);
  if (button === undefined) throw new Error(`no button ${text}`);
  await act(async () => button.props.onClick?.({ preventDefault: () => {} }));
};

const submit = async (tree: ReactTestRenderer) => {
  const form = tree.root.findByType("form");
  await act(async () => form.props.onSubmit({ preventDefault: () => {} }));
};

const alertText = (tree: ReactTestRenderer) =>
  tree.root
    .findAll((node) => node.props?.role === "alert")
    .map((node) => String(node.props.children))
    .join(" ");

describe("RoutineForm trigger picker", () => {
  it("defaults to a schedule and never asks for an event name", async () => {
    const tree = await renderForm();
    expect(buttonWithText(tree, "On a schedule")?.props["aria-pressed"]).toBe(true);
    expect(buttonWithText(tree, "When an event fires")?.props["aria-pressed"]).toBe(false);
    expect(fieldById(tree, "routine-event-label")).toBeUndefined();
    expect(fieldById(tree, "routine-time")).toBeDefined();
  });

  it("swaps the schedule inputs for one event-name field", async () => {
    const tree = await renderForm();
    await press(tree, "When an event fires");
    expect(buttonWithText(tree, "When an event fires")?.props["aria-pressed"]).toBe(true);
    expect(fieldById(tree, "routine-event-label")).toBeDefined();
    // Nothing schedule-shaped is left on screen to confuse or to validate.
    expect(fieldById(tree, "routine-time")).toBeUndefined();
    expect(fieldById(tree, "routine-hours")).toBeUndefined();
    expect(fieldById(tree, "routine-zone")).toBeUndefined();
    expect(buttonWithText(tree, "Every few hours")).toBeUndefined();
  });

  it("sends an event routine with its label and no schedule", async () => {
    const tree = await renderForm();
    await press(tree, "When an event fires");
    await type(tree, "routine-title", "PR watch");
    await type(tree, "routine-prompt", "Tell me what changed.");
    await type(tree, "routine-event-label", "PR merged");
    await submit(tree);

    expect(state.calls.length).toBe(1);
    const input = (state.calls[0]!.target as { input: Record<string, unknown> }).input;
    expect(state.calls[0]!.command).toBe("create");
    expect(input.trigger).toBe("event");
    expect(input.eventLabel).toBe("PR merged");
    expect(input.schedule).toBeUndefined();
  });

  it("refuses an unnamed event instead of creating a nameless webhook", async () => {
    const tree = await renderForm();
    await press(tree, "When an event fires");
    await type(tree, "routine-title", "PR watch");
    await type(tree, "routine-prompt", "Tell me what changed.");
    await submit(tree);

    expect(state.calls).toEqual([]);
    expect(alertText(tree)).toContain("Name the event");
  });

  it("still sends a schedule when the picker is left alone", async () => {
    const tree = await renderForm();
    await type(tree, "routine-title", "Morning");
    await type(tree, "routine-prompt", "Brief me.");
    await submit(tree);

    const input = (state.calls[0]!.target as { input: Record<string, unknown> }).input;
    expect(input.schedule).toEqual({ kind: "daily", time: "09:00" });
    expect(input.trigger).toBeUndefined();
    expect(input.eventLabel).toBeUndefined();
  });
});

describe("RoutineForm default bot", () => {
  const botSelect = (tree: ReactTestRenderer) => tree.root.findByType("select");
  const loaded = [
    { botId: "bot-assistant", name: "Assistant", sortOrder: 0 },
    { botId: "bot-planner", name: "Planner", sortOrder: 1 },
  ];

  it("picks Planner once a cold list loads, as a warm open does", async () => {
    state.bots = null;
    const tree = await renderForm();
    state.bots = loaded;
    await act(async () => tree.update(<RoutineForm routine={null} />));
    expect(botSelect(tree).props.value).toBe("bot-planner");
  });

  it("keeps the owner's pick when the list refreshes", async () => {
    state.bots = loaded;
    const tree = await renderForm();
    await act(async () => botSelect(tree).props.onChange({ target: { value: "bot-assistant" } }));
    state.bots = [...loaded];
    await act(async () => tree.update(<RoutineForm routine={null} />));
    expect(botSelect(tree).props.value).toBe("bot-assistant");
  });
});

describe("RoutineForm notify choice", () => {
  const notifyRadios = (tree: ReactTestRenderer) =>
    tree.root.findAllByType("input").filter((node) => node.props.name === "routine-notify");
  const radioLabels = (tree: ReactTestRenderer) =>
    tree.root
      .findAllByType("label")
      .filter((node) => node.findAllByProps({ name: "routine-notify" }).length > 0)
      .map((node) => String(node.props.children[1]));
  const checkedIndex = (tree: ReactTestRenderer) =>
    notifyRadios(tree).findIndex((node) => node.props.checked === true);
  const hint = (tree: ReactTestRenderer) =>
    String(tree.root.findByProps({ id: "routine-notify-hint" }).props.children);
  const sent = () => (state.calls[0]!.target as { input: Record<string, unknown> }).input;
  const fill = async (tree: ReactTestRenderer) => {
    await type(tree, "routine-title", "Morning");
    await type(tree, "routine-prompt", "Brief me.");
  };
  const stored = (extra: Record<string, unknown>) =>
    ({
      routineId: "routine-1",
      botId: "bot-a",
      title: "Morning",
      prompt: "Brief me.",
      trigger: "schedule",
      eventLabel: null,
      timeZone: "Europe/London",
      missedPolicy: "coalesce",
      schedule: { kind: "daily", time: "09:00" },
      ...extra,
    }) as unknown as PersonalRoutine;

  it("offers the three choices, Every run first and selected", async () => {
    const tree = await renderForm();
    expect(radioLabels(tree)).toEqual(["Every run", "When the bot decides", "Never"]);
    expect(checkedIndex(tree)).toBe(0);
    expect(hint(tree)).toContain("each time it finishes");
  });

  it("omits the default on create and carries a chosen mode", async () => {
    const plain = await renderForm();
    await fill(plain);
    await submit(plain);
    expect(sent().notifyMode).toBeUndefined();

    await act(async () => renderer?.unmount());
    state.calls = [];
    const tree = await renderForm();
    await fill(tree);
    await act(async () => notifyRadios(tree)[1]!.props.onChange());
    expect(hint(tree)).toContain("worth your attention");
    await submit(tree);
    expect(sent().notifyMode).toBe("bot_decides");
  });

  it("explains that never is silent but problems still notify", async () => {
    const tree = await renderForm();
    await act(async () => notifyRadios(tree)[2]!.props.onChange());
    expect(hint(tree)).toContain("Problems and anything that needs you still notify");
    await fill(tree);
    await submit(tree);
    expect(sent().notifyMode).toBe("never");
  });

  it("carries the mode on an event routine too", async () => {
    const tree = await renderForm();
    await press(tree, "When an event fires");
    await fill(tree);
    await type(tree, "routine-event-label", "PR merged");
    await act(async () => notifyRadios(tree)[2]!.props.onChange());
    await submit(tree);
    expect(sent()).toMatchObject({ trigger: "event", notifyMode: "never" });
  });

  it("edits: reads the stored mode, sends only a change", async () => {
    const tree = await renderForm(stored({ notifyMode: "never" }));
    expect(checkedIndex(tree)).toBe(2);
    await submit(tree);
    expect(state.calls[0]!.command).toBe("update");
    expect(sent().notifyMode).toBeUndefined();

    state.calls = [];
    await act(async () => notifyRadios(tree)[0]!.props.onChange());
    await submit(tree);
    expect(sent().notifyMode).toBe("always");
  });

  it("reads an older routine with no notifyMode as Every run", async () => {
    const tree = await renderForm(stored({}));
    expect(checkedIndex(tree)).toBe(0);
    await submit(tree);
    expect(sent().notifyMode).toBeUndefined();
  });

  it("hides When the bot decides for a relay routine and sends always", async () => {
    const tree = await renderForm(stored({ delivery: "relay", notifyMode: "bot_decides" }));
    expect(radioLabels(tree)).toEqual(["Every run", "Never"]);
    expect(checkedIndex(tree)).toBe(0);
    await submit(tree);
    expect(sent().notifyMode).toBe("always");
  });
});
