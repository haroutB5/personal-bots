import { useCallback, useState } from "react";

import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";

import { newMessageId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import type { ChatAttachment, ChatMessage, Thread } from "~/types";
import { useAtomCommand } from "~/state/use-atom-command";

import { readChatNotice } from "./chatNotices";
import { readServerTurn } from "./delegationModel";
import { readGroupMarker } from "./groupModel";

/** The owner's message a failed turn belongs to, as Retry re-sends it. */
export interface RetryTarget {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
  /**
   * The message never got a turn, so Retry re-requests the turn for it under
   * the same id (the server does not post it twice). A message whose turn
   * started and failed is sent again under a new id: an id that already has a
   * turn is never reused.
   */
  readonly turnStarted: boolean;
}

/** Drops the web-only fields (`previewUrl`, `downloadable`) a command must not carry. */
function toContractAttachment(attachment: ChatAttachment): ContractChatAttachment {
  const {
    previewUrl: _previewUrl,
    downloadable: _downloadable,
    ...rest
  } = attachment as ChatAttachment & { previewUrl?: string; downloadable?: boolean };
  return rest as ContractChatAttachment;
}

/**
 * The message a Retry re-sends: the owner's own last message. Null when the
 * last user-role message is not the owner's (a task, routine or server notice
 * wrote it) or there is none, so no Retry is offered for a turn the owner did
 * not start.
 */
export function findRetryTarget(messages: ReadonlyArray<ChatMessage>): RetryTarget | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") continue;
    if (
      readChatNotice(message) !== null ||
      readServerTurn(message) !== null ||
      readGroupMarker(message) !== null
    ) {
      return null;
    }
    return {
      messageId: message.id,
      text: message.text,
      attachments: (message.attachments ?? []).map(toContractAttachment),
      ...(message.context !== undefined ? { context: message.context } : {}),
      turnStarted: message.turnId !== null,
    };
  }
  return null;
}

/**
 * The `thread.turn.start` input for a Retry. Pure (the new id and timestamp
 * are parameters) so the same-id / new-id rule is unit-testable. Model and
 * modes follow `PersonalComposer`: the bot's selection wins while it is on the
 * thread's provider instance, else the thread's own.
 */
export function buildRetryTurnInput({
  threadId,
  thread,
  botModelSelection,
  target,
  freshMessageId,
  createdAt,
}: {
  threadId: ThreadId;
  thread: Pick<Thread, "modelSelection" | "runtimeMode" | "interactionMode">;
  botModelSelection: ModelSelection | null;
  target: RetryTarget;
  freshMessageId: MessageId;
  createdAt: string;
}) {
  const first = target.attachments[0];
  return {
    threadId,
    message: {
      messageId: target.turnStarted ? freshMessageId : target.messageId,
      role: "user" as const,
      text: target.text,
      attachments: [...target.attachments],
      ...(target.context !== undefined ? { context: target.context } : {}),
    },
    modelSelection:
      botModelSelection !== null &&
      botModelSelection.instanceId === thread.modelSelection.instanceId
        ? botModelSelection
        : thread.modelSelection,
    titleSeed: truncate(
      target.text ||
        (first ? `${first.type === "image" ? "Image" : "File"}: ${first.name}` : "New chat"),
    ),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt,
  };
}

/**
 * Re-sends the owner's failed message. `busy` stays true from the tap until
 * the session moves on from the failure it was tapped on (`failureKey`), so the
 * button cannot be pressed twice while the server picks the turn up.
 */
export function useRetryFailedTurn(input: {
  readonly environmentId: EnvironmentId | null;
  readonly thread: Thread | null;
  readonly botModelSelection: ModelSelection | null;
  readonly target: RetryTarget | null;
  /** Identifies the failure on screen, e.g. the session's `updatedAt`. */
  readonly failureKey: string | null;
}): { readonly retry: () => Promise<boolean>; readonly busy: boolean } {
  const { environmentId, thread, botModelSelection, target, failureKey } = input;
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [inFlight, setInFlight] = useState(false);
  const [sentFor, setSentFor] = useState<string | null>(null);

  const retry = useCallback(async () => {
    if (environmentId === null || thread === null || target === null || inFlight) return false;
    setInFlight(true);
    try {
      const result = await startTurn({
        environmentId,
        input: buildRetryTurnInput({
          threadId: thread.id,
          thread,
          botModelSelection,
          target,
          freshMessageId: newMessageId(),
          createdAt: new Date().toISOString(),
        }),
      });
      const ok = result._tag === "Success";
      setSentFor(ok ? failureKey : null);
      return ok;
    } catch {
      setSentFor(null);
      return false;
    } finally {
      setInFlight(false);
    }
  }, [botModelSelection, environmentId, failureKey, inFlight, startTurn, target, thread]);

  return { retry, busy: inFlight || (sentFor !== null && sentFor === failureKey) };
}
