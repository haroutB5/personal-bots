import type { MessageId } from "@t3tools/contracts";

/**
 * A file a chat message links: the path as the message writes it, and the
 * message whose per-message grant lets the server open it.
 */
export interface FileOpenRequest {
  readonly path: string;
  readonly messageId: MessageId;
}
