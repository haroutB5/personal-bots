import * as Schema from "effect/Schema";

/**
 * A line the server writes into a bot chat on its own behalf: the chat paused
 * on a provider usage limit, and the automatic continue once it reset. Rides
 * on the message's `context` like {@link PERSONAL_TASK_MESSAGE_CONTEXT_KIND}:
 * no text references it, so providers never see it, and clients render the
 * message as a compact system row instead of a bubble.
 */
export const PERSONAL_CHAT_NOTICE_CONTEXT_KIND = "personal-chat-notice";

/**
 * usage-limit-paused: the turn stopped on a usage limit (an assistant-role row).
 * usage-limit-resumed: the server's continue turn after the reset (a user-role
 * turn message, since the provider needs a prompt; never the owner's words).
 * team-bot-change: a team lead created, edited or removed a bot on its team
 * (an assistant-role row whose text is the whole line; `provider` is unused
 * there and carries "Team").
 * team-bot-answer: the server's turn message telling a lead how the owner
 * answered its change request (a user-role turn message, since the provider
 * needs a prompt; never the owner's words; rendered as a system row).
 * release-landed: the server's turn message telling the bot that asked for an
 * hbots release how it went (live, rolled back), posted from the release
 * waiter's notice (a user-role turn message, rendered as a system row).
 */
export const PersonalChatNoticeKind = Schema.Literals([
  "usage-limit-paused",
  "usage-limit-resumed",
  "team-bot-change",
  "team-bot-answer",
  "release-landed",
]);
export type PersonalChatNoticeKind = typeof PersonalChatNoticeKind.Type;

export const PersonalChatNoticeMarker = Schema.Struct({
  notice: PersonalChatNoticeKind,
  /** Provider as the owner knows it: "Claude", "Codex". */
  provider: Schema.String,
  /** When the chat continues on its own (ISO). Absent: no reset was reported, so it will not. */
  resumeAt: Schema.optional(Schema.String),
});
export type PersonalChatNoticeMarker = typeof PersonalChatNoticeMarker.Type;
