import { expect, it } from "vite-plus/test";

import { approvalThreadIdOf, type BotSummary } from "./botSummaries.ts";

const shell = (id: string, hasPendingApprovals: boolean) =>
  ({ id, hasPendingApprovals, hasPendingUserInput: !hasPendingApprovals }) as never;

const summary = (input: Partial<BotSummary>): BotSummary =>
  ({
    hasPendingApprovals: false,
    needsBrowserHelp: false,
    needsSecret: false,
    attentionThreads: [],
    ...input,
  }) as BotSummary;

it("opens the chat that holds the approval, even when it is a task chat", () => {
  expect(
    approvalThreadIdOf(
      summary({
        hasPendingApprovals: true,
        attentionThreads: [shell("asks-a-question", false), shell("task-chat", true)],
      }),
    ),
  ).toBe("task-chat");
});

it("keeps the usual target when the row shows another status", () => {
  expect(approvalThreadIdOf(summary({}))).toBeNull();
  expect(
    approvalThreadIdOf(
      summary({
        hasPendingApprovals: true,
        needsSecret: true,
        attentionThreads: [shell("task-chat", true)],
      }),
    ),
  ).toBeNull();
});
