import { expect, it } from "vite-plus/test";
import { transcriptRange, TRANSCRIPT_WINDOW_SIZE } from "./transcriptWindow";

const rows = Array.from({ length: 1010 }, (_, index) => ({ id: `row-${index}` }));
it("opens bounded at the tail and retains a reader's identity across incoming and prepended rows", () => {
  expect(transcriptRange(rows, null)).toEqual({ start: 930, end: 1010 });
  const reading = transcriptRange(rows, "row-500");
  expect(reading).toEqual({ start: 500, end: 580 });
  const appended = [...rows, { id: "new" }];
  expect(transcriptRange(appended, "row-500")).toEqual(reading);
  const prepended = [{ id: "old" }, ...appended];
  const range = transcriptRange(prepended, "row-500");
  expect(prepended[range.start]?.id).toBe("row-500");
  expect(range.end - range.start).toBe(TRANSCRIPT_WINDOW_SIZE);
  expect(transcriptRange(appended, null)).toEqual({ start: 931, end: 1011 });
});
