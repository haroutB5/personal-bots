import { expect, it } from "vite-plus/test";

import { leadBotTextDiff } from "./leadBotTextDiff";

const shape = (before: string, after: string) =>
  leadBotTextDiff(before, after).map((line) => `${line.kind[0]}:${line.text}`);

it("marks removed and added lines and keeps the shared ones", () => {
  expect(shape("a\nb\nc", "a\nB\nc\nd")).toEqual(["s:a", "r:b", "a:B", "s:c", "a:d"]);
});

it("treats an empty side as all added or all removed", () => {
  expect(shape("", "x\ny")).toEqual(["a:x", "a:y"]);
  expect(shape("x", "")).toEqual(["r:x"]);
  expect(shape("", "")).toEqual([]);
});

it("keeps every character of the new text, in order", () => {
  const after = "  keep  spaces \n\n<b>not markup</b>\n# not a heading";
  const rebuilt = leadBotTextDiff("old\n<b>not markup</b>", after)
    .filter((line) => line.kind !== "removed")
    .map((line) => line.text)
    .join("\n");
  expect(rebuilt).toBe(after);
});

it("falls back to remove-all then add-all for very large mismatches", () => {
  const big = Array.from({ length: 2100 }, (_, i) => `x${i}`).join("\n");
  const other = Array.from({ length: 2100 }, (_, i) => `y${i}`).join("\n");
  const out = leadBotTextDiff(big, other);
  expect(out.filter((line) => line.kind === "removed")).toHaveLength(2100);
  expect(out.filter((line) => line.kind === "added")).toHaveLength(2100);
});
