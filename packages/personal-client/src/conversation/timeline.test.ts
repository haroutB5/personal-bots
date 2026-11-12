import { MessageId, TurnId, type UserInputAttachmentAnswerPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildConversationItems } from "./conversationModel.ts";
import { deriveTimelineEntries, htmlRenderEntriesFromActivities } from "./timeline.ts";
import type { ChatMessage, ProposedPlan, WorkLogEntry } from "./types.ts";
import type { OrchestrationThreadActivity } from "./wireTypes.ts";

const message = (id: string, role: ChatMessage["role"], createdAt: string): ChatMessage =>
  ({
    id: MessageId.make(id),
    role,
    text: id,
    turnId: null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  }) as ChatMessage;

const plan = (id: string, createdAt: string): ProposedPlan =>
  ({
    id,
    turnId: TurnId.make("turn-1"),
    planMarkdown: "- step",
    implementedAt: null,
    implementationThreadId: null,
    createdAt,
    updatedAt: createdAt,
  }) as ProposedPlan;

const work = (id: string, createdAt: string, answeredRequestId?: string): WorkLogEntry => ({
  id,
  createdAt,
  label: id,
  tone: "info",
  ...(answeredRequestId === undefined
    ? {}
    : { questionAnswer: { requestId: answeredRequestId } as UserInputAttachmentAnswerPayload }),
});

describe("deriveTimelineEntries", () => {
  it("orders messages, plans and work rows by time", () => {
    const entries = deriveTimelineEntries(
      [
        message("m2", "assistant", "2026-11-08T10:00:03.000Z"),
        message("m1", "user", "2026-11-08T10:00:01.000Z"),
      ],
      [plan("p1", "2026-11-08T10:00:02.000Z")],
      [work("w1", "2026-11-08T10:00:04.000Z")],
    );
    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ["message", "m1"],
      ["proposed-plan", "p1"],
      ["message", "m2"],
      ["work", "w1"],
    ]);
  });

  it("drops the user message of an async answer its work row already shows", () => {
    const entries = deriveTimelineEntries(
      [
        message("async-answer:req-1", "user", "2026-11-08T10:00:01.000Z"),
        message("async-answer:req-2", "user", "2026-11-08T10:00:02.000Z"),
      ],
      [],
      [work("w1", "2026-11-08T10:00:03.000Z", "req-1")],
    );
    expect(entries.map((entry) => entry.id)).toEqual(["async-answer:req-2", "w1"]);
  });
});

const toolActivity = (
  id: string,
  createdAt: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity =>
  ({
    id,
    tone: "tool",
    kind: "dynamic_tool",
    summary: "Html render",
    payload: { id, type: "dynamic_tool", ...payload },
    turnId: null,
    createdAt,
  }) as unknown as OrchestrationThreadActivity;

const pageOutput = {
  htmlRender: {
    attachmentId: "thread-1-abc-html",
    title: "hbots widget mockups",
    height: 640,
    heights: [
      [320, 900],
      [728, 640],
    ],
  },
};

describe("htmlRenderEntriesFromActivities", () => {
  it("reads the page a finished page tool call showed", () => {
    const entries = htmlRenderEntriesFromActivities([
      toolActivity("item-1", "2026-11-08T10:00:02.000Z", {
        status: "completed",
        toolName: "mcp__t3-code__html_render",
        output: pageOutput,
        outputOmitted: true,
      }),
    ]);
    expect(entries).toEqual([
      {
        id: "item-1",
        kind: "html-render",
        createdAt: "2026-11-08T10:00:02.000Z",
        htmlRender: pageOutput.htmlRender,
      },
    ]);
  });

  it("ignores a running call, another tool and a failed page", () => {
    const entries = htmlRenderEntriesFromActivities([
      toolActivity("running", "2026-11-08T10:00:02.000Z", {
        status: "running",
        toolName: "html_render",
        output: pageOutput,
      }),
      toolActivity("other", "2026-11-08T10:00:03.000Z", {
        status: "completed",
        toolName: "html_preview",
        output: pageOutput,
      }),
      toolActivity("failed", "2026-11-08T10:00:04.000Z", {
        status: "completed",
        toolName: "html_render",
        output: { isError: true, ...pageOutput },
      }),
    ]);
    expect(entries).toEqual([]);
  });

  it("places the page in the chat where the bot showed it, with tool steps off", () => {
    const items = buildConversationItems(
      deriveTimelineEntries(
        [
          message("m1", "user", "2026-11-08T10:00:01.000Z"),
          message("m2", "assistant", "2026-11-08T10:00:03.000Z"),
        ],
        [],
        [],
        [
          toolActivity("item-1", "2026-11-08T10:00:02.000Z", {
            status: "completed",
            toolName: "html_render",
            output: pageOutput,
          }),
        ],
      ),
      { showToolSteps: false },
    );
    expect(items.map((item) => item.kind)).toEqual([
      "divider",
      "message",
      "html-render",
      "message",
    ]);
  });
});
