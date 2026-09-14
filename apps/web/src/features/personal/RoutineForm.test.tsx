import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RoutineForm } from "./RoutineForm";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly target: unknown }>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => async () => {},
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({
    data: { bots: [{ botId: "bot-a", name: "Planner", sortOrder: 0 }] },
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
  vi.unstubAllGlobals();
});

const renderForm = async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<RoutineForm routine={null} />);
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
