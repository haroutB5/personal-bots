import { act, create, type ReactTestInstance } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

import { snoozePresets } from "./chatState";
import { SnoozePresetList } from "./SnoozeSheet";

// Base UI's sheet needs a DOM; the list of choices is the part with behaviour.
const presets = snoozePresets(new Date(2026, 9, 6, 9, 30));

function render(onPick = vi.fn(), onCancel = vi.fn()) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<SnoozePresetList presets={presets} onPick={onPick} onCancel={onCancel} />);
  });
  const buttons = () => renderer.root.findAllByType("button");
  return { buttons, onPick, onCancel, renderer };
}

const textOf = (node: ReactTestInstance) =>
  node.findAll((child) => typeof child.children[0] === "string").map((child) => child.children[0]);

it("lists each preset with its time, then Cancel, every button named", () => {
  const { buttons } = render();
  const names = buttons().map((button) => button.props["aria-label"] ?? textOf(button).join(""));
  expect(names).toEqual([
    "In 1 hour, Today 10:30",
    "This evening, Today 18:00",
    "Tomorrow, Tomorrow 09:00",
    "Next week, Mon 12 Oct 09:00",
    "Cancel",
  ]);
});

it("a tap on a choice hands back that preset", () => {
  const { buttons, onPick } = render();
  act(() => buttons()[2]!.props.onClick());
  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onPick.mock.calls[0]![0].key).toBe("tomorrow");
});

it("Cancel picks nothing", () => {
  const { buttons, onPick, onCancel } = render();
  act(() => buttons()[4]!.props.onClick());
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onPick).not.toHaveBeenCalled();
});
