import { describe, expect, it } from "vite-plus/test";

import { deriveLatestProgressNote } from "./latestProgress";

const requestedAt = "2026-09-29T10:00:00.000Z";
const turn = { requestedAt };

const reasoning = (text: string, at: string) => ({
  role: "reasoning" as const,
  text,
  createdAt: at,
  updatedAt: at,
});
const tool = (title: string, at: string, extra: Record<string, unknown> = {}) => ({
  kind: "tool.started",
  summary: `${title} started`,
  payload: { title, ...extra },
  createdAt: at,
});

describe("deriveLatestProgressNote", () => {
  it("is null unless a turn is running", () => {
    const messages = [reasoning("**Reading the test**", "2026-09-29T10:00:02.000Z")];
    expect(
      deriveLatestProgressNote({ working: false, messages, activities: [], latestTurn: turn }),
    ).toBe(null);
    expect(
      deriveLatestProgressNote({ working: true, messages, activities: [], latestTurn: null }),
    ).toBe(null);
    expect(
      deriveLatestProgressNote({ working: true, messages: [], activities: [], latestTurn: turn }),
    ).toBe(null);
  });

  it("shows the latest thinking summary of the running turn, one plain line", () => {
    expect(
      deriveLatestProgressNote({
        working: true,
        messages: [
          reasoning("**Old turn**", "2026-09-29T09:00:00.000Z"),
          reasoning(
            "**Reading the failing test**\n\nI need to look at the budget.",
            "2026-09-29T10:00:02.000Z",
          ),
        ],
        activities: [],
        latestTurn: turn,
      }),
    ).toBe("Reading the failing test");
  });

  it("uses the newest of the two, and a tool title when there is no thinking", () => {
    const messages = [reasoning("**Planning the fix**", "2026-09-29T10:00:02.000Z")];
    expect(
      deriveLatestProgressNote({
        working: true,
        messages,
        activities: [tool("Running tests", "2026-09-29T10:00:09.000Z")],
        latestTurn: turn,
      }),
    ).toBe("Running tests");
    expect(
      deriveLatestProgressNote({
        working: true,
        messages: [],
        activities: [tool("Running tests", "2026-09-29T10:00:09.000Z")],
        latestTurn: turn,
      }),
    ).toBe("Running tests");
  });

  it("ignores steps and thinking from before the turn was requested", () => {
    expect(
      deriveLatestProgressNote({
        working: true,
        messages: [reasoning("**Earlier turn**", "2026-09-29T09:59:00.000Z")],
        activities: [tool("Earlier step", "2026-09-29T09:59:30.000Z")],
        latestTurn: turn,
      }),
    ).toBe(null);
  });

  it("never reads tool output, arguments or detail", () => {
    const note = deriveLatestProgressNote({
      working: true,
      messages: [],
      activities: [
        tool("Running tests", "2026-09-29T10:00:09.000Z", {
          detail: "cat .env; TOKEN=abcdefghijklmnopqrstuvwxyz0123456789",
          data: { item: { command: "curl -H 'Authorization: Bearer supersecrettokenvalue123'" } },
        }),
      ],
      latestTurn: turn,
    });
    expect(note).toBe("Running tests");
  });

  it("falls back to the summary without its started tail, and skips non-tool activities", () => {
    expect(
      deriveLatestProgressNote({
        working: true,
        messages: [],
        activities: [
          {
            kind: "tool.started",
            summary: "Searching the repo started",
            payload: {},
            createdAt: "2026-09-29T10:00:03.000Z",
          },
          {
            kind: "context-window.updated",
            summary: "Context window updated",
            payload: {},
            createdAt: "2026-09-29T10:00:04.000Z",
          },
        ],
        latestTurn: turn,
      }),
    ).toBe("Searching the repo");
  });

  it("blanks a secret in the thinking line", () => {
    const note = deriveLatestProgressNote({
      working: true,
      messages: [
        reasoning(
          "Trying token=abcdefghijklmnopqrstuvwxyz0123456789 against the API",
          "2026-09-29T10:00:02.000Z",
        ),
      ],
      activities: [],
      latestTurn: turn,
    });
    expect(note).toContain("[hidden]");
    expect(note).not.toContain("abcdefghijklmnop");
  });
});
