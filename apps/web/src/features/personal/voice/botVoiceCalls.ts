/**
 * Who can be called, and the bot's call colour, in one place.
 *
 * Harout, 16 Oct 2026: "any team lead should have this enabled for them. If
 * it's a regular bot or agent then it doesn't get it." The bot's own team-lead
 * flag is the only authority (`botTakesVoiceCalls`); the older per-bot
 * "Allow voice calls" switch is gone from the form and decides nothing. This
 * module exists so the chat, the call bar and the call UI all read it the same
 * way, and so the contract's helper is named once instead of in five
 * components.
 *
 * @module features/personal/voice/botVoiceCalls
 */
import { botTakesVoiceCalls } from "@t3tools/contracts";

/** True when this bot can be called: it is a team lead. */
export function botVoiceCallsEnabled(bot: unknown): boolean {
  if (typeof bot !== "object" || bot === null) return false;
  return botTakesVoiceCalls(bot as { readonly lead?: boolean | undefined });
}

/** The bot's own colour, or the app's neutral, for the call UI. */
export function botVoiceCallColour(bot: unknown): string {
  if (typeof bot !== "object" || bot === null) return "#6f6f6b";
  const colour = (bot as Record<string, unknown>).avatarColor;
  return typeof colour === "string" && colour.length > 0 ? colour : "#6f6f6b";
}
