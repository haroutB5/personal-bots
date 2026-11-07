import { WRAPUP_CHAT_PROMPT } from "@t3tools/contracts";
import type {
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

import { chatTurnModelSelection } from "./chatModelSelection.ts";

export { WRAPUP_CHAT_PROMPT };

/** The parts of a loaded chat a wrapup turn copies. */
export interface WrapupThread {
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * Builds the `thread.turn.start` input for a wrapup turn. Pure (message id
 * and timestamp are parameters) so the send shape is unit-testable. Field
 * selection mirrors `PersonalComposer`: the bot's current model settings win
 */
export function buildWrapupTurnInput({
  threadId,
  thread,
  botModelSelection,
  messageId,
  createdAt,
}: {
  threadId: ThreadId;
  thread: WrapupThread;
  botModelSelection: ModelSelection | null;
  messageId: MessageId;
  createdAt: string;
}) {
  return {
    threadId,
    message: {
      messageId,
      role: "user" as const,
      text: WRAPUP_CHAT_PROMPT,
      attachments: [],
    },
    modelSelection: chatTurnModelSelection(botModelSelection, thread.modelSelection),
    titleSeed: thread.title,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt,
  };
}
