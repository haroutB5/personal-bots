import type { BotStatusTone } from "./botSummaries";

/*
 * The one line under a bot's name on the Team card (design A, SPEC-final
 * 2.10): what the bot is doing right now in words - "Working", "Thinking",
 * "Needs approval" - and its model with effort when it is idle. The words are
 * the app's own (`botStatus`), so the card, the Bots list and the chat header
 * never disagree about what a bot is doing; only the tone is the card's.
 */

export type TeamCaptionTone = "working" | "needs" | "thinking" | "idle";

export interface TeamCaption {
  readonly text: string;
  readonly tone: TeamCaptionTone;
}

export interface TeamCaptionInput {
  /** `botStatus(summary, now)`: the words and tone the rest of the app shows. */
  readonly status: { readonly label: string; readonly tone: BotStatusTone };
  /** A turn is running now. */
  readonly live: boolean;
  /** Live, and nothing out of the turn yet. */
  readonly thinking: boolean;
  /** The bot's model and effort ("Sonnet 5.5 · H"), shown when it is idle. */
  readonly modelLabel: string | null;
  /** The live turn's latest step, the lead's caption while it works. */
  readonly progressNote: string | null;
}

/**
 * The caption: a state that wants the owner (approval, question, secret,
 * browser help, a broken provider) in amber, then the working states in green
 * or grey, then the model when the bot has nothing to say. "Waiting on
 * Developer" and the rest of the idle statuses stay idle-toned: they are
 * context, not something to act on.
 */
export function teamBotCaption(input: TeamCaptionInput): TeamCaption {
  if (input.status.tone === "review") return { text: input.status.label, tone: "needs" };
  if (input.live) {
    return input.thinking
      ? { text: "Thinking", tone: "thinking" }
      : { text: input.progressNote ?? "Working", tone: "working" };
  }
  if (input.status.tone === "waiting") return { text: input.status.label, tone: "idle" };
  return { text: input.modelLabel ?? input.status.label, tone: "idle" };
}
