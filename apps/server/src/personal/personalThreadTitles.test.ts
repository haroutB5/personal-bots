import { describe, expect, it } from "@effect/vitest";

import {
  PERSONAL_TASK_THREAD_TITLE_MAX_LENGTH,
  PERSONAL_THREAD_TITLE,
  PERSONAL_TITLE_SEED_COMMAND_TAG,
  personalProviderTitleAllowed,
  personalTaskMessageId,
  personalTaskThreadTitle,
} from "./personalThreadTitles.ts";

const seedState = {
  source: "generated" as const,
  version: `server:${PERSONAL_TITLE_SEED_COMMAND_TAG}:1`,
};

describe("personalProviderTitleAllowed", () => {
  it("lets a user-started chat's placeholder or seed go once, on its first turn", () => {
    expect(
      personalProviderTitleAllowed({
        title: PERSONAL_THREAD_TITLE,
        titleState: null,
        userMessageIds: ["user-1"],
      }),
    ).toBe(true);
    expect(
      personalProviderTitleAllowed({
        title: "plan my week",
        titleState: seedState,
        userMessageIds: ["user-1"],
      }),
    ).toBe(true);
  });

  it("keeps a title once anything replaced the seed", () => {
    for (const version of ["server:thread-title-rename:1", "provider:evt:thread-meta-update"]) {
      expect(
        personalProviderTitleAllowed({
          title: "Weekly plan",
          titleState: { source: "generated", version },
          userMessageIds: ["user-1"],
        }),
      ).toBe(false);
    }
  });

  it("never overrides a manual rename", () => {
    expect(
      personalProviderTitleAllowed({
        title: PERSONAL_THREAD_TITLE,
        titleState: { source: "manual", version: "cmd-rename" },
        userMessageIds: ["user-1"],
      }),
    ).toBe(false);
  });

  it("never renames a task, routine or group chat", () => {
    for (const messageId of [personalTaskMessageId("task-1", 1), "personal-group-r1-brief-1"]) {
      expect(
        personalProviderTitleAllowed({
          title: PERSONAL_THREAD_TITLE,
          titleState: null,
          userMessageIds: [messageId],
        }),
      ).toBe(false);
    }
    // A routine posting into a user's chat marks it too.
    expect(
      personalProviderTitleAllowed({
        title: "plan my week",
        titleState: seedState,
        userMessageIds: ["user-1", personalTaskMessageId("task-2", 1)],
      }),
    ).toBe(false);
  });

  it("applies on the first turn only", () => {
    expect(
      personalProviderTitleAllowed({
        title: "plan my week",
        titleState: seedState,
        userMessageIds: ["user-1", "user-2"],
      }),
    ).toBe(false);
    expect(
      personalProviderTitleAllowed({
        title: PERSONAL_THREAD_TITLE,
        titleState: null,
        userMessageIds: [],
      }),
    ).toBe(false);
  });
});

describe("personalTaskThreadTitle", () => {
  it("uses the task title on one line", () => {
    expect(personalTaskThreadTitle("  Morning\n news\tdigest  ")).toBe("Morning news digest");
  });

  it("falls back to the placeholder for an empty title", () => {
    expect(personalTaskThreadTitle("   ")).toBe(PERSONAL_THREAD_TITLE);
  });

  it("cuts a long title at a word, within the limit", () => {
    const long =
      "Review every open pull request in the personal-bots repository and summarise what each one changes for the owner";
    const title = personalTaskThreadTitle(long);
    expect(title.length).toBeLessThanOrEqual(PERSONAL_TASK_THREAD_TITLE_MAX_LENGTH);
    expect(title.endsWith("…")).toBe(true);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    expect(long[title.length - 1]).toBe(" ");
  });

  it("cuts a long unbroken title hard", () => {
    const title = personalTaskThreadTitle("x".repeat(200));
    expect(title).toBe(`${"x".repeat(PERSONAL_TASK_THREAD_TITLE_MAX_LENGTH - 1)}…`);
  });
});
