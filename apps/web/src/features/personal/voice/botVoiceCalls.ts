/**
 * The per-bot "Allow voice calls" switch and the bot's call colour, in one
 * place.
 *
 * The field itself is Backend's (`allowVoiceCalls` on the bot contract, read
 * through `botAllowsVoiceCalls`). This module exists so the chat, the form and
 * the call UI all read it the same way, and so the contract's helper is named
 * once instead of in five components.
 *
 * @module features/personal/voice/botVoiceCalls
 */
import { botAllowsVoiceCalls } from "@t3tools/contracts";

/** True when this bot can be called. Absent (an older server) reads as off. */
export function botVoiceCallsEnabled(bot: unknown): boolean {
  if (typeof bot !== "object" || bot === null) return false;
  return botAllowsVoiceCalls(bot as { readonly allowVoiceCalls?: boolean | undefined });
}

/** The bot's own colour, or the app's neutral, for the call UI. */
export function botVoiceCallColour(bot: unknown): string {
  if (typeof bot !== "object" || bot === null) return "#6f6f6b";
  const colour = (bot as Record<string, unknown>).avatarColor;
  return typeof colour === "string" && colour.length > 0 ? colour : "#6f6f6b";
}
