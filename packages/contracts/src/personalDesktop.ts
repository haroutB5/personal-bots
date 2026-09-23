import * as Schema from "effect/Schema";

/**
 * The user's real Windows desktop, driven by one bot at a time. A bot holds it
 * from its first desktop action until the turn ends, it calls
 * `computer_release`, it goes idle, or the user stops it (hotkey or app).
 * Other bots queue behind the holder.
 */

/** The key that stops a bot and takes the PC back (Ctrl+Alt+Esc works too). */
export const PERSONAL_DESKTOP_STOP_HOTKEY = "Esc";

export const PersonalDesktopClaimant = Schema.Struct({
  threadId: Schema.String,
  botId: Schema.String,
  botName: Schema.String,
});
export type PersonalDesktopClaimant = typeof PersonalDesktopClaimant.Type;

export const PersonalDesktopHolder = Schema.Struct({
  threadId: Schema.String,
  botId: Schema.String,
  botName: Schema.String,
  /** ISO-8601 UTC instant the bot got the PC. */
  since: Schema.String,
  /** ISO-8601 UTC instant of its latest desktop action. */
  lastActionAt: Schema.String,
});
export type PersonalDesktopHolder = typeof PersonalDesktopHolder.Type;

export const PersonalDesktopStopReason = Schema.Literals(["hotkey", "app", "idle"]);
export type PersonalDesktopStopReason = typeof PersonalDesktopStopReason.Type;

export const PersonalDesktopStop = Schema.Struct({
  threadId: Schema.String,
  botName: Schema.String,
  by: PersonalDesktopStopReason,
  at: Schema.String,
});
export type PersonalDesktopStop = typeof PersonalDesktopStop.Type;

export const PersonalDesktopStatus = Schema.Struct({
  /** False where the server cannot drive a desktop (not Windows). */
  available: Schema.Boolean,
  holder: Schema.NullOr(PersonalDesktopHolder),
  /** Bots waiting for the PC, first in line first. */
  waiting: Schema.Array(PersonalDesktopClaimant),
  lastStop: Schema.NullOr(PersonalDesktopStop),
  stopHotkey: Schema.String,
});
export type PersonalDesktopStatus = typeof PersonalDesktopStatus.Type;

export class PersonalDesktopError extends Schema.TaggedError<PersonalDesktopError>()(
  "PersonalDesktopError",
  { message: Schema.String },
) {}
