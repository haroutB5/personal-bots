import { describe, expect, it } from "vite-plus/test";

import {
  canCancelTask,
  canRetryTask,
  formatLocalDateTime,
  parseTaskListFilter,
  taskListFor,
  taskStatusTone,
} from "./taskPresentation";

describe("task lists", () => {
  it("puts every status in exactly one list", () => {
    expect(taskListFor("running")).toBe("active");
    expect(taskListFor("rate_limited")).toBe("active");
    expect(taskListFor("waiting_for_user")).toBe("waiting");
    expect(taskListFor("waiting_for_agent")).toBe("waiting");
    expect(taskListFor("cancelled")).toBe("completed");
    expect(taskListFor("failed")).toBe("completed");
  });

  it("parses the view search param, defaulting to Active", () => {
    expect(parseTaskListFilter("scheduled")).toBe("scheduled");
    expect(parseTaskListFilter("bogus")).toBe("active");
    expect(parseTaskListFilter(undefined)).toBe("active");
  });

  it("offers Cancel only for live tasks and Retry only for retryable ones", () => {
    expect(canCancelTask("running")).toBe(true);
    expect(canCancelTask("completed")).toBe(false);
    expect(canRetryTask("failed")).toBe(true);
    expect(canRetryTask("completed")).toBe(false);
    expect(canRetryTask("running")).toBe(false);
  });

  it("marks only real attention states", () => {
    expect(taskStatusTone("running")).toBe("live");
    expect(taskStatusTone("waiting_for_user")).toBe("review");
    expect(taskStatusTone("queued")).toBe("none");
  });
});

describe("formatLocalDateTime", () => {
  it("renders London wall time across DST", () => {
    expect(formatLocalDateTime(Date.parse("2026-09-14T08:00:00Z"))).toBe("Mon 14 Sep, 09:00");
    expect(formatLocalDateTime(Date.parse("2026-12-14T08:00:00Z"))).toBe("Mon 14 Dec, 08:00");
    expect(formatLocalDateTime(Date.parse("2026-09-14T08:00:00Z"), "America/New_York")).toBe(
      "Mon 14 Sep, 04:00",
    );
  });
});
