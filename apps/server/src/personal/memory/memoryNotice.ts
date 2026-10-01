import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  ComposerContextId,
  MessageId,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  type OrchestrationMessageContext,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import { PERSONAL_NOTICE_MESSAGE_ID_PREFIX } from "../personalChatResumePolicy.ts";

const context: OrchestrationMessageContext = {
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make(PERSONAL_CHAT_NOTICE_CONTEXT_KIND),
      label: "Chat notice",
      kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
      payload: { notice: "memory-saved", provider: "Memory" },
    },
  ],
};

const shownText = (content: string) => {
  const text = content.replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 240).trimEnd()}...` : text;
};

/** The chat line for a save that waits for the owner's OK. */
export function memoryProposedLine(input: {
  readonly content: string;
  readonly reach: string;
  readonly kind: "note" | "preference";
  readonly replaced: number;
}): string {
  const replaced =
    input.replaced === 0
      ? ""
      : ` (replacing ${input.replaced} older ${input.replaced === 1 ? "entry" : "entries"})`;
  return `Memory: a bot proposes a ${input.kind} for ${input.reach}${replaced}, waiting for your OK on the Memory screen: "${shownText(input.content)}"`;
}

/** The chat line for a saved preference other bots will follow. */
export function memorySavedLine(input: {
  readonly content: string;
  readonly reach: string;
  readonly replaced: number;
  readonly forgotten?: boolean | undefined;
  /** Not done: waiting for the owner's OK. */
  readonly pending?: boolean | undefined;
}): string {
  const shown = shownText(input.content);
  if (input.forgotten === true) {
    return input.pending === true
      ? `Memory: a bot asks to forget an entry for ${input.reach}, waiting for your OK on the Memory screen: "${shown}"`
      : `Memory: forgot a preference for ${input.reach}: "${shown}"`;
  }
  const replaced =
    input.replaced === 0
      ? ""
      : ` (replaces ${input.replaced} older ${input.replaced === 1 ? "entry" : "entries"})`;
  return `Memory: saved a preference for ${input.reach}${replaced}: "${shown}"`;
}

/**
 * Writes the line into the bot's chat as a system row (assistant role, the
 * "memory-saved" notice), so the owner sees every new standing rule land.
 * Best effort: the save already happened.
 */
export const writeMemoryNotice = (
  engine: OrchestrationEngine.OrchestrationEngineService["Service"],
  threadId: ThreadId,
  line: string,
) =>
  Effect.gen(function* () {
    const key = `memory-${NodeCrypto.randomUUID()}`;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const messageId = MessageId.make(PERSONAL_NOTICE_MESSAGE_ID_PREFIX + key);
    yield* engine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: CommandId.make(`${key}:notice:delta`),
      threadId,
      messageId,
      delta: line,
      context,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.make(`${key}:notice:complete`),
      threadId,
      messageId,
      createdAt,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("personal memory notice could not be written", {
            threadId,
            cause: Cause.pretty(cause),
          }),
    ),
  );
