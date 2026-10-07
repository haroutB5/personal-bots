import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import {
  DESKTOP_IMAGE_TOOLS,
  DragInput,
  HoldKeyInput,
  MouseDownInput,
  MouseUpInput,
  ScrollInput,
} from "./tools.ts";

const accepts = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(schema as Schema.Decoder<unknown>)(value)._tag === "Success";

const byName = (name: string) => {
  const tool = DESKTOP_IMAGE_TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
};

it("registers the 1.66.6 desktop tools and states their limits", () => {
  const names = DESKTOP_IMAGE_TOOLS.map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining(["computer_mouse_down", "computer_mouse_up", "computer_hold_key"]),
  );
  const down = byName("computer_mouse_down").description ?? "";
  expect(down).toMatch(/Always finish with computer_mouse_up/);
  expect(down).toMatch(/let go automatically/);
  expect(down).toMatch(/over 60 seconds/);
  expect(down).toMatch(/computer_release/);
  expect(down).toMatch(/turn ends/);
  // The shared wording: one bot at a time, a queue, coordinates from the latest screenshot.
  for (const name of ["computer_mouse_down", "computer_mouse_up", "computer_hold_key"]) {
    expect(byName(name).description, name).toMatch(/one bot at a time/);
    expect(byName(name).description, name).toMatch(/call again to keep your place/);
    expect(byName(name).description, name).toMatch(/latest computer_screenshot/);
  }
  const hold = byName("computer_hold_key").description ?? "";
  expect(hold).toMatch(/30000 \(30 s at most\)/);
  expect(hold).toMatch(/always let go/);
  expect(hold).toMatch(/cannot type/);
  expect(hold).toMatch(/2000 ms/);
  expect(hold).toMatch(/passwords/);
  expect(byName("computer_drag").description).toMatch(/modifiers/);
  expect(byName("computer_scroll").description).toMatch(/modifiers/);
  // Every parameter that is not a coordinate or an after-action option explains itself.
  for (const name of ["computer_mouse_down", "computer_mouse_up", "computer_hold_key"]) {
    const schema = Tool.getJsonSchema(byName(name)) as {
      properties?: Record<string, { description?: string; anyOf?: unknown[] }>;
    };
    for (const [field, value] of Object.entries(schema.properties ?? {})) {
      const described =
        typeof value.description === "string" ||
        (value.anyOf ?? []).some(
          (member) => typeof (member as { description?: string }).description === "string",
        );
      expect(described, `${name}.${field}`).toBe(true);
    }
  }
});

it("mouse down and up take an optional point and button; hold takes keys and a whole duration", () => {
  expect(accepts(MouseDownInput, {})).toBe(true);
  expect(accepts(MouseDownInput, { x: 1, y: 2, button: "right" })).toBe(true);
  expect(accepts(MouseDownInput, { button: "back" })).toBe(false);
  expect(accepts(MouseUpInput, { x: 1, y: 2 })).toBe(true);
  expect(accepts(HoldKeyInput, { keys: "shift", durationMs: 500 })).toBe(true);
  expect(accepts(HoldKeyInput, { keys: "shift" })).toBe(false);
  expect(accepts(HoldKeyInput, { durationMs: 500 })).toBe(false);
  expect(accepts(HoldKeyInput, { keys: "shift", durationMs: 1.5 })).toBe(false);
});

it("drag and scroll take modifiers like click does", () => {
  expect(accepts(DragInput, { fromX: 1, fromY: 2, toX: 3, toY: 4, modifiers: "shift" })).toBe(true);
  expect(accepts(ScrollInput, { direction: "down", modifiers: "ctrl" })).toBe(true);
  expect(accepts(ScrollInput, { direction: "down", modifiers: ["ctrl"] })).toBe(false);
});
