/**
 * The Instructions box in a real browser at phone width: collapsed to about
 * six lines at first, opened by its control or by focus, text kept throughout.
 */
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { BotInstructionsField } from "./BotInstructionsField";

const LONG = Array.from(
  { length: 40 },
  (_, index) => `Rule ${index + 1}: read the handbook before any work and report evidence.`,
).join("\n");

function Harness() {
  const [value, setValue] = useState(LONG);
  return (
    <div className="p-4" style={{ width: 360 }}>
      <BotInstructionsField value={value} onChange={setValue} />
    </div>
  );
}

it("opens collapsed, expands on Show all and on focus, and keeps edits", async () => {
  await page.viewport(360, 785);
  await using screen = await render(<Harness />);
  const box = screen.getByLabelText("Instructions");
  const element = box.element() as HTMLTextAreaElement;
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);

  await expect.element(screen.getByRole("button", { name: "Show all" })).toBeVisible();
  const collapsed = element.getBoundingClientRect().height;
  expect(collapsed).toBeGreaterThan(lineHeight * 5.5);
  expect(collapsed).toBeLessThan(lineHeight * 8);

  await screen.getByRole("button", { name: "Show all" }).click();
  await expect.element(screen.getByRole("button", { name: "Show less" })).toBeVisible();
  expect(element.getBoundingClientRect().height).toBeGreaterThan(lineHeight * 40);
  expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight + 1);

  await box.fill(`${LONG}\nRule 41: added while expanded.`);
  await screen.getByRole("button", { name: "Show less" }).click();
  await expect.element(screen.getByRole("button", { name: "Show all" })).toBeVisible();
  expect(element.value.endsWith("Rule 41: added while expanded.")).toBe(true);
  expect(element.getBoundingClientRect().height).toBeLessThan(lineHeight * 8);

  await box.click();
  await expect.element(screen.getByRole("button", { name: "Show less" })).toBeVisible();
  expect(element.value.endsWith("Rule 41: added while expanded.")).toBe(true);
});
