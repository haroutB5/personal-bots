import { describe, expect, it } from "vite-plus/test";

import { plainPreviewLine, previewOf, snapshotPreviewLabel } from "./BotRow";
import type { BotSummary } from "./botSummaries";
import type { ServerTurn } from "./delegationModel";

const describeTurn = (turn: ServerTurn) => `Working on ${turn.title}`;

function summary(
  message: { readonly id: string; readonly role: string; readonly text: string } | null,
): BotSummary {
  return {
    bot: { botId: "bot-a" },
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

describe("working bot preview", () => {
  const working = (progressNote: string | null | undefined, live = true): BotSummary =>
    ({
      bot: { botId: "bot-a" },
      newestThread: { id: "thread-a", title: "Weekly plan" },
      newestMessage: { id: "m", role: "assistant", text: "The last thing it said" },
      live,
      progressNote,
    }) as unknown as BotSummary;

  it("shows the progress note instead of the stale last message while it works", () => {
    expect(previewOf(working("Reading the failing test"), describeTurn)).toBe(
      "Reading the failing test",
    );
  });

  it("goes back to the last message when it stops working, or has no note", () => {
    expect(previewOf(working("Reading the failing test", false), describeTurn)).toBe(
      "The last thing it said",
    );
    expect(previewOf(working(null), describeTurn)).toBe("The last thing it said");
    expect(previewOf(working(undefined), describeTurn)).toBe("The last thing it said");
    expect(previewOf(working(""), describeTurn)).toBe("The last thing it said");
  });

  it("never persists the note to the cold-start snapshot", () => {
    expect(snapshotPreviewLabel(working("Reading the failing test"), describeTurn)).toBeNull();
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

describe("hidden previews (the owner's privacy switch)", () => {
  const secret = "No alerts. Portfolio £27,636 at 21:06 (Kraken)";
  const hiddenSummary = (patch: Record<string, unknown> = {}): BotSummary =>
    ({
      bot: { botId: "cfo", hidePreviews: true },
      newestThread: { id: "thread-a", title: "Portfolio check" },
      newestMessage: { id: "m", role: "assistant", text: secret },
      live: false,
      progressNote: "Checking Kraken balance",
      ...patch,
    }) as unknown as BotSummary;

  it("shows a neutral line, never the message, the note, the title or a turn label", () => {
    expect(previewOf(hiddenSummary(), describeTurn)).toBe("Preview hidden");
    // Working: the status word stays, the note does not.
    expect(previewOf(hiddenSummary({ live: true }), describeTurn)).toBe("Working");
    // A turn the task service wrote carries task titles: hidden too.
    const turn = hiddenSummary({
      newestMessage: {
        id: "personal-task-task-1-1",
        role: "user",
        text:
          "[Task from you]" +
          String.fromCharCode(10, 10) +
          "Task id: task-1" +
          String.fromCharCode(10) +
          "Title: Book the flights",
      },
    });
    expect(previewOf(turn, describeTurn)).toBe("Preview hidden");
    expect(snapshotPreviewLabel(turn, describeTurn)).toBe("Preview hidden");
    // No chat yet is a status, not a message.
    expect(
      previewOf(hiddenSummary({ newestThread: null, newestMessage: null }), describeTurn),
    ).toBe("No chats yet");
  });

  it("follows the server's hidden mark even if the bot row is stale", () => {
    const stale = hiddenSummary({
      bot: { botId: "cfo" },
      newestMessage: { id: "m", role: "assistant", text: "", hidden: true },
    });
    expect(previewOf(stale, describeTurn)).toBe("Preview hidden");
    expect(snapshotPreviewLabel(stale, describeTurn)).toBe("Preview hidden");
  });

  it("is off by default: a bot without the switch previews as before", () => {
    const shown = hiddenSummary({
      bot: { botId: "cfo", hidePreviews: false },
      progressNote: undefined,
    });
    expect(previewOf(shown, describeTurn)).toBe(secret);
    expect(snapshotPreviewLabel(shown, describeTurn)).toBeNull();
  });
});
