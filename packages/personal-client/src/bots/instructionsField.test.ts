import { describe, expect, it } from "vite-plus/test";

import {
  instructionsCollapsedHeight,
  instructionsExpandedAfter,
  instructionsFieldView,
} from "./instructionsField.ts";

describe("instructions field", () => {
  const collapsedHeight = instructionsCollapsedHeight(22, 20);

  it("is about six lines tall when collapsed", () => {
    expect(collapsedHeight).toBe(152);
  });

  it("opens collapsed with a fade and Show all when the text is longer", () => {
    expect(instructionsFieldView({ expanded: false, contentHeight: 900, collapsedHeight })).toEqual(
      {
        clipHeight: 152,
        fade: true,
        control: "Show all",
      },
    );
  });

  it("offers nothing when the text already fits", () => {
    expect(instructionsFieldView({ expanded: false, contentHeight: 64, collapsedHeight })).toEqual({
      clipHeight: 152,
      fade: false,
      control: null,
    });
    expect(
      instructionsFieldView({ expanded: false, contentHeight: 153, collapsedHeight }).control,
    ).toBe(null);
    expect(
      instructionsFieldView({ expanded: true, contentHeight: 64, collapsedHeight }).control,
    ).toBe(null);
  });

  it("stays collapsed without a control before the first measure", () => {
    expect(
      instructionsFieldView({ expanded: false, contentHeight: null, collapsedHeight }),
    ).toEqual({
      clipHeight: 152,
      fade: false,
      control: null,
    });
  });

  it("shows all of the text with Show less once expanded", () => {
    expect(instructionsFieldView({ expanded: true, contentHeight: 900, collapsedHeight })).toEqual({
      clipHeight: null,
      fade: false,
      control: "Show less",
    });
  });

  it("expands on focus and stays expanded, and the control flips it", () => {
    expect(instructionsExpandedAfter(false, "focus")).toBe(true);
    expect(instructionsExpandedAfter(true, "focus")).toBe(true);
    expect(instructionsExpandedAfter(false, "toggle")).toBe(true);
    expect(instructionsExpandedAfter(true, "toggle")).toBe(false);
  });
});
