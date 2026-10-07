import { expect, it } from "@effect/vitest";
import {
  PreviewAutomationClickInput,
  PreviewAutomationCloseTabInput,
  PreviewAutomationDragInput,
  PreviewAutomationHistoryInput,
  PreviewAutomationHoverInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import { PreviewToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

const schemaHasMultipleAllOfDescriptions = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  const allOf = Array.isArray(record.allOf) ? record.allOf : [];
  const descriptionCount = allOf.filter(
    (member) =>
      member !== null &&
      typeof member === "object" &&
      typeof (member as Record<string, unknown>).description === "string",
  ).length;
  return descriptionCount > 1 || Object.values(record).some(schemaHasMultipleAllOfDescriptions);
};

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(PreviewToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    if (tool.name === "preview_navigate") {
      expect(schemaHasMultipleAllOfDescriptions(schema)).toBe(false);
    }
    expect(
      schema.properties?.tabId,
      `${tool.name} must allow an explicit collaborative browser tab target`,
    ).toBeDefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

it("exports exact object result schemas for preview actions", () => {
  const actionNames = [
    "preview_click",
    "preview_hover",
    "preview_drag",
    "preview_type",
    "preview_press",
    "preview_scroll",
    "preview_wait_for",
  ] as const;
  for (const name of actionNames) {
    // Effect's tool schemas follow the decoder default since rc.113 and leave
    // unmodeled result keys open.
    expect(Tool.getJsonSchemaFromSchema(PreviewToolkit.tools[name].successSchema)).toEqual({
      type: "object",
      properties: { toolIcon: expect.any(Object) },
      additionalProperties: true,
      description: "The preview action completed successfully.",
    });
  }
});

const accepts = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(schema as Schema.Decoder<unknown>)(value)._tag === "Success";

it("lists the 1.66.6 browser tools, each with its limits in the description", () => {
  const tools = PreviewToolkit.tools;
  expect(Object.keys(tools)).toEqual(
    expect.arrayContaining([
      "preview_click",
      "preview_hover",
      "preview_drag",
      "preview_history",
      "preview_close_tab",
    ]),
  );
  expect(tools.preview_click.description).toMatch(/button.*right.*middle/);
  expect(tools.preview_click.description).toMatch(/clicks \(1 to 3/);
  expect(tools.preview_click.description).toMatch(/modifiers/);
  expect(tools.preview_click.description).toMatch(
    /background tab that the preview tools cannot drive/,
  );
  expect(tools.preview_click.description).toMatch(/saved login was filled only plain left clicks/);
  expect(tools.preview_hover.description).toMatch(/without clicking/);
  expect(tools.preview_hover.description).toMatch(/saved login was filled only x\/y/);
  expect(tools.preview_drag.description).toMatch(/fromLocator and toLocator/);
  expect(tools.preview_drag.description).toMatch(/Do not mix/);
  expect(tools.preview_drag.description).toMatch(
    /files from the computer into a page is not available/,
  );
  expect(tools.preview_history.description).toMatch(/reload/);
  expect(tools.preview_history.description).toMatch(/same approval as preview_navigate/);
  expect(tools.preview_close_tab.description).toMatch(/tabId \(it is required/);
  expect(tools.preview_close_tab.description).toMatch(/while the user is controlling the browser/);
  // No upload tool: no bot sends a file from this computer to a website.
  expect(Object.keys(tools).some((name) => /upload|file/i.test(name))).toBe(false);
});

it("click takes a button, 1 to 3 clicks and held keys, and nothing else new", () => {
  const base = { x: 1, y: 2 };
  expect(accepts(PreviewAutomationClickInput, base)).toBe(true);
  expect(accepts(PreviewAutomationClickInput, { ...base, button: "right", clicks: 2 })).toBe(true);
  expect(
    accepts(PreviewAutomationClickInput, { locator: "text=Row", modifiers: ["Control", "Shift"] }),
  ).toBe(true);
  expect(accepts(PreviewAutomationClickInput, { ...base, button: "back" })).toBe(false);
  expect(accepts(PreviewAutomationClickInput, { ...base, clicks: 0 })).toBe(false);
  expect(accepts(PreviewAutomationClickInput, { ...base, clicks: 4 })).toBe(false);
  expect(accepts(PreviewAutomationClickInput, { ...base, clicks: 1.5 })).toBe(false);
  expect(accepts(PreviewAutomationClickInput, { ...base, modifiers: ["Enter"] })).toBe(false);
  // Still exactly one target.
  expect(accepts(PreviewAutomationClickInput, { ...base, locator: "text=Row" })).toBe(false);
});

it("hover takes exactly one target", () => {
  expect(accepts(PreviewAutomationHoverInput, { locator: "text=Menu" })).toBe(true);
  expect(accepts(PreviewAutomationHoverInput, { selector: "#menu" })).toBe(true);
  expect(accepts(PreviewAutomationHoverInput, { x: 1, y: 2 })).toBe(true);
  expect(accepts(PreviewAutomationHoverInput, {})).toBe(false);
  expect(accepts(PreviewAutomationHoverInput, { x: 1 })).toBe(false);
  expect(accepts(PreviewAutomationHoverInput, { locator: "a", x: 1, y: 2 })).toBe(false);
});

it("drag takes locator to locator or x/y to x/y, never a mix", () => {
  expect(accepts(PreviewAutomationDragInput, { fromLocator: "#a", toLocator: "#b" })).toBe(true);
  expect(accepts(PreviewAutomationDragInput, { fromX: 1, fromY: 2, toX: 3, toY: 4 })).toBe(true);
  expect(accepts(PreviewAutomationDragInput, {})).toBe(false);
  expect(accepts(PreviewAutomationDragInput, { fromLocator: "#a" })).toBe(false);
  expect(accepts(PreviewAutomationDragInput, { fromX: 1, fromY: 2, toX: 3 })).toBe(false);
  expect(accepts(PreviewAutomationDragInput, { fromLocator: "#a", toX: 3, toY: 4 })).toBe(false);
  expect(
    accepts(PreviewAutomationDragInput, {
      fromLocator: "#a",
      toLocator: "#b",
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
    }),
  ).toBe(false);
});

it("history is back, forward or reload; closing a tab needs a tab id", () => {
  for (const action of ["back", "forward", "reload"]) {
    expect(accepts(PreviewAutomationHistoryInput, { action })).toBe(true);
  }
  expect(accepts(PreviewAutomationHistoryInput, { action: "refresh" })).toBe(false);
  expect(accepts(PreviewAutomationHistoryInput, {})).toBe(false);
  expect(accepts(PreviewAutomationHistoryInput, { action: "back", readiness: "none" })).toBe(true);
  expect(accepts(PreviewAutomationCloseTabInput, { tabId: "tab-1" })).toBe(true);
  expect(accepts(PreviewAutomationCloseTabInput, {})).toBe(false);
  expect(accepts(PreviewAutomationCloseTabInput, { tabId: "" })).toBe(false);
  expect(accepts(PreviewAutomationCloseTabInput, { tabId: " tab-1" })).toBe(false);
});
