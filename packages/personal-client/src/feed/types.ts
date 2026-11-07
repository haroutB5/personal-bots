import type { PersonalReplyQuote } from "@t3tools/contracts";

/** A message the user sent that the server has not echoed back yet. */
export interface PendingOutgoingMessage {
  readonly id: string;
  /** The chat it was sent in; it only ever renders there. */
  readonly threadId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly attachments: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The message it replies to, drawn above it like the sent one. */
  readonly replyTo?: PersonalReplyQuote | undefined;
}
