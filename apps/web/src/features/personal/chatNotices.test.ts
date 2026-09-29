import { PERSONAL_CHAT_NOTICE_CONTEXT_KIND } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "~/session-logic";

import { previewOf } from "./BotRow";
import type { BotSummary } from "./botSummaries";
import {
  chatNoticeLabel,
  isServerTurnNotice,
  readChatNotice,
  RESUMED_NOTICE_LABEL,
} from "./chatNotices";
import { buildConversationItems, isTurnBoundary } from "./conversationModel";
import { deriveLatestMessageReadStatus, USER_MESSAGE_DELIVERED_KIND } from "./messageReadStatus";

const context = (payload: unknown) => ({
  version: 1,
  records: [
    {
      version: 1,
      contextId: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
      label: "Chat notice",
      kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
      payload,
    },
  ],
});

const PAUSED = {
  notice: "usage-limit-paused",
  provider: "Claude",
  resumeAt: "2026-09-27T22:00:05.000Z",
};
const RESUMED = { notice: "usage-limit-resumed", provider: "Claude" };
const PROMPT = "[Auto-continue after usage reset] Your previous turn stopped because …";
const NOW = Date.parse("2026-09-27T19:43:00.000Z");

const entry = (
  id: string,
  role: "user" | "assistant",
  createdAt: string,
  text: string,
  payload?: unknown,
) =>
  ({
    id,
    kind: "message",
    createdAt,
    message: {
      id,
      role,
      text,
      createdAt,
      streaming: false,
      ...(payload === undefined ? {} : { context: context(payload) }),
    },
  }) as unknown as TimelineEntry;

const transcript = [
  entry("owner-1", "user", "2026-09-27T19:40:00.000Z", "Build the release"),
  entry("assistant-1", "assistant", "2026-09-27T19:42:36.000Z", "You've hit your session limit"),
  entry(
    "personal-notice-r1",
    "assistant",
    "2026-09-27T19:42:37.000Z",
    "Paused: Claude usage limit. Continues at 23:00.",
    PAUSED,
  ),
  entry("personal-resume-r1", "user", "2026-09-27T22:00:10.000Z", PROMPT, RESUMED),
  entry("assistant-2", "assistant", "2026-09-27T22:01:00.000Z", "Done."),
];

describe("chat notices", () => {
  it("shows a team lead's bot change as its own line, with no usage-limit wording", () => {
    const line = "CFO created bot 'Tax' (Sonnet 5.5 · H) on Finance";
    const notice = readChatNotice({
      context: context({ notice: "team-bot-change", provider: "Team" }),
    } as never);
    expect(notice).toEqual({ notice: "team-bot-change", provider: "Team" });
    expect(chatNoticeLabel(notice!, line, NOW)).toBe(line);
  });

  it("shows the server's answer to a lead as a system row in the owner's place, as written", () => {
    const text = "Harout approved your request to remove Tax.";
    const answer = { notice: "team-bot-answer", provider: "Team" };
    const notice = readChatNotice({ context: context(answer) } as never)!;
    expect(chatNoticeLabel(notice, `${text}\n`, NOW)).toBe(text);
    expect(isServerTurnNotice(notice)).toBe(true);
    expect(isServerTurnNotice({ notice: "team-bot-change", provider: "Team" })).toBe(false);

    const items = buildConversationItems([
      entry("owner-1", "user", "2026-09-27T19:40:00.000Z", "Remove Tax"),
      entry("assistant-1", "assistant", "2026-09-27T19:41:00.000Z", "Asked."),
      entry("personal-answer-1", "user", "2026-09-27T19:45:00.000Z", text, answer),
    ]);
    const row = items.find((item) => item.id === "personal-answer-1")!;
    expect(row.kind).toBe("notice");
    expect(isTurnBoundary(row)).toBe(true);
  });

  it("reads the marker and says when the chat continues", () => {
    const notice = readChatNotice({ context: context(PAUSED) } as never)!;
    expect(chatNoticeLabel(notice, "Paused: Claude usage limit. Continues at 23:00.", NOW)).toBe(
      "Paused: Claude usage limit. Continues at 23:00.",
    );
    // The time comes from the marker in the device's zone, not the server's text.
    expect(
      chatNoticeLabel(notice, "Paused: Claude usage limit. Continues at 23:00.", NOW, "UTC"),
    ).toBe("Paused: Claude usage limit. Continues at 22:00.");
    expect(
      chatNoticeLabel(
        { notice: "usage-limit-paused", provider: "Codex" },
        "Paused: Codex usage limit. No reset time was reported, so send a message to continue.",
        NOW,
      ),
    ).toBe("Paused: Codex usage limit. No reset time was reported, so send a message to continue.");
    expect(readChatNotice({ context: context({ notice: "other" }) } as never)).toBeNull();
    expect(readChatNotice({})).toBeNull();
  });

  it("shows both as system rows, never as the owner's bubble or the bot's reply", () => {
    const items = buildConversationItems(transcript);
    expect(items.map((item) => item.kind)).toEqual([
      "divider",
      "message",
      "message",
      "notice",
      "divider",
      "notice",
      "message",
    ]);
    const resumed = items.find((item) => item.id === "personal-resume-r1")!;
    expect(isTurnBoundary(resumed)).toBe(true);
    expect(resumed.kind === "notice" && chatNoticeLabel(resumed.notice, PROMPT, NOW)).toBe(
      RESUMED_NOTICE_LABEL,
    );
    // "Read" stays under the owner's own message, not the server's continue.
    const status = deriveLatestMessageReadStatus({
      items,
      activities: [
        { kind: USER_MESSAGE_DELIVERED_KIND, payload: { messageId: "owner-1" } },
      ] as never,
      busy: false,
      latestTurn: null,
    });
    expect(status).toEqual({ messageId: "owner-1", status: "read" });
  });

  it("previews the notice, not the prompt, on the Bots list", () => {
    const summary = (text: string, payload: unknown, id: string) =>
      ({
        newestThread: { title: "Release" },
        newestMessage: { id, role: "user", text, context: context(payload) },
      }) as unknown as BotSummary;
    expect(previewOf(summary(PROMPT, RESUMED, "personal-resume-r1"), () => "")).toBe(
      RESUMED_NOTICE_LABEL,
    );
  });
});
