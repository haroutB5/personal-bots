import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  ComposerContextId,
  MessageId,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  type OrchestrationMessageContext,
  type PersonalChatNoticeMarker,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import { PERSONAL_NOTICE_MESSAGE_ID_PREFIX } from "../personalChatResumePolicy.ts";

/** How much of a note its chat line shows. */
const SHOWN_CHARS = 80;

/** "Saved a note: <first 80 chars>" / "Forgot a rule: ...", on one line. */
export function noteChangedLine(
  action: "saved" | "forgot" | "replaced",
  content: string,
  kind: "note" | "rule" = "note",
): string {
  const text = content.replace(/\s+/g, " ").trim();
  const shown = text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS).trimEnd()}...` : text;
  const verb = action === "saved" ? "Saved" : action === "replaced" ? "Replaced" : "Forgot";
  return `${verb} a ${kind}: ${shown}`;
}

/**
 * Writes the line into the bot's chat as a system row (assistant role, the
 * "memory-saved" notice) carrying the note's id, so the row can offer Undo.
 * Best effort: the change already happened.
 */
export const writeNoteNotice = (
  engine: OrchestrationEngine.OrchestrationEngineService["Service"],
  input: {
    readonly threadId: ThreadId;
    readonly line: string;
    readonly memoryId: string;
    readonly undo: "archive" | "restore" | "unreplace";
  },
) =>
  Effect.gen(function* () {
    const key = `memory-${NodeCrypto.randomUUID()}`;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const messageId = MessageId.make(PERSONAL_NOTICE_MESSAGE_ID_PREFIX + key);
    const payload: PersonalChatNoticeMarker = {
      notice: "memory-saved",
      provider: "Memory",
      memoryId: input.memoryId,
      undo: input.undo,
    };
    const context: OrchestrationMessageContext = {
      version: 1,
      records: [
        {
          version: 1,
          contextId: ComposerContextId.make(PERSONAL_CHAT_NOTICE_CONTEXT_KIND),
          label: "Chat notice",
          kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
          payload,
        },
      ],
    };
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: CommandId.make(`${key}:notice:delta`),
      threadId: input.threadId,
      messageId,
      delta: input.line,
      context,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.make(`${key}:notice:complete`),
      threadId: input.threadId,
      messageId,
      createdAt,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("personal memory note line could not be written", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
    ),
  );
