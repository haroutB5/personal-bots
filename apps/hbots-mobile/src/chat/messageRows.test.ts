import { describe, expect, it, vi } from "vite-plus/test";

import { createRowReverser } from "./messageRows";

type Row = { readonly key: string };

function rowsOf(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({ key: `r${index}` }));
}

describe("the reversed list", () => {
  it("is not computed again for the same rows", () => {
    const reverse = createRowReverser<Row>();
    const rows = rowsOf(30);
    const spy = vi.spyOn(rows, "toReversed");

    const first = reverse(rows);
    const second = reverse(rows);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first[0]).toBe(rows[rows.length - 1]);
  });

  it("is computed again when the rows change", () => {
    const reverse = createRowReverser<Row>();
    const first = reverse(rowsOf(3));
    const second = reverse(rowsOf(4));

    expect(second).not.toBe(first);
    expect(second).toHaveLength(4);
  });
});
