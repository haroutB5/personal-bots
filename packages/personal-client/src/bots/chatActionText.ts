export interface DeleteChatOptions {
  /** Another chat than the open one: the confirm names it. */
  readonly title?: string | undefined;
  /** A turn is running in the chat: the confirm says deleting stops it too. */
  readonly working?: boolean | undefined;
  /**
   * The chat's name for the failure line only (the confirm names a chat through
   * `title`, and says "this chat" for the open one). With a name the failure
   * reads `Couldn't delete “X”: <reason>` like Archive's.
   */
  readonly name?: string | undefined;
}

const open = "“";
const close = "”";

/** The chat's name in the sentences that name it: “Tennis”. */
export function quotedChatName(title: string): string {
  return `${open}${title}${close}`;
}

/**
 * What a failed action on another chat says, naming the chat: with the server's
 * own reason when it gave one, else "Try again."
 */
export function chatActionFailure(
  action: "archive" | "delete" | "rename",
  title: string,
  reason?: string,
): string {
  const lead = `Couldn't ${action} ${quotedChatName(title)}`;
  return reason === undefined ? `${lead}. Try again.` : `${lead}: ${reason}`;
}

/** Confirm copy, kept pure so the permanent-deletion wording is unit-tested. */
export function deleteChatConfirmMessage(options: DeleteChatOptions = {}): string {
  const subject = options.title === undefined ? "this chat" : `“${options.title}”`;
  const lines = [
    `Delete ${subject} permanently?`,
    "The whole conversation is removed and can't be undone.",
  ];
  if (options.working === true) {
    lines.push("It is working right now; deleting it stops that too.");
  }
  return lines.join("\n");
}
