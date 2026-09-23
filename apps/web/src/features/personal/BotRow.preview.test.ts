import { describe, expect, it } from "vite-plus/test";

import { plainPreviewLine, previewOf, snapshotPreviewLabel } from "./BotRow";
import type { BotSummary } from "./botSummaries";
import type { ServerTurn } from "./delegationModel";

const describeTurn = (turn: ServerTurn) => `Working on ${turn.title}`;

function summary(
  message: { readonly id: string; readonly role: string; readonly text: string } | null,
): BotSummary {
  return {
    newestThread: { id: "thread-a", title: "Weekly plan" },
    newestMessage: message,
  } as unknown as BotSummary;
}

describe("chats list preview", () => {
  it("shows the newest message line but never persists it", () => {
    const secret = "my passport number is 123456789";
    const row = summary({ id: "msg-1", role: "assistant", text: `${secret}\nsecond line` });

    // On screen: the real message line, as the list has always shown.
    expect(previewOf(row, describeTurn)).toBe(secret);
    // On disk: nothing derived from the message body. The snapshot lives in
    // localStorage with no credential in front of it.
    expect(snapshotPreviewLabel(row, describeTurn)).toBeNull();
  });

  it("persists a server-authored turn label, which is not user content", () => {
    const row = summary({
      id: "personal-task-task-1-1",
      role: "user",
      text: "[Task from you]\n\nTask id: task-1\nTitle: Book the flights",
    });

    expect(snapshotPreviewLabel(row, describeTurn)).toBe("Working on Book the flights");
    expect(previewOf(row, describeTurn)).toBe("Working on Book the flights");
  });

  it("falls back to nothing persistable when the bot has no messages yet", () => {
    expect(snapshotPreviewLabel(summary(null), describeTurn)).toBeNull();
    // The thread title is the builder's fallback, and it is server metadata.
    expect(previewOf(summary(null), describeTurn)).toBe("Weekly plan");
  });
});

describe("plainPreviewLine", () => {
  it("drops the markdown around the words", () => {
    expect(plainPreviewLine("## VERDICT")).toBe("VERDICT");
    expect(plainPreviewLine("**Cause** was the offset")).toBe("Cause was the offset");
    expect(plainPreviewLine("Done. Report at `C:/Claude/AI/report.md`")).toBe(
      "Done. Report at C:/Claude/AI/report.md",
    );
    expect(plainPreviewLine("- first point")).toBe("first point");
    expect(plainPreviewLine("2. second point")).toBe("second point");
    expect(plainPreviewLine("> quoted")).toBe("quoted");
    expect(plainPreviewLine("See [the docs](https://example.com/x) now")).toBe("See the docs now");
    expect(plainPreviewLine("an _emphasised_ word")).toBe("an emphasised word");
  });

  it("keeps words that only look like markdown", () => {
    expect(plainPreviewLine("snake_case_name stays")).toBe("snake_case_name stays");
    expect(plainPreviewLine("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("treats a fence or a rule as an empty line, so the preview moves on", () => {
    expect(plainPreviewLine("```ts")).toBe("");
    expect(plainPreviewLine("---")).toBe("");
    const row = summary({ id: "m", role: "assistant", text: "## \n---\n**Result:** it works" });
    expect(previewOf(row, describeTurn)).toBe("Result: it works");
  });
});
