import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ModelSelection, ThreadId } from "@t3tools/contracts";

import type * as PersonalBotRepository from "./PersonalBotRepository.ts";

/**
 * The model selection the composer sends for a bot chat: the bot's own when
 * it is on the thread's provider instance, else the thread's. The prewarmed
 * session must match it, or the send restarts the session.
 */
export const sendModelSelection = (
  botModelSelection: ModelSelection,
  threadModelSelection: ModelSelection,
): ModelSelection =>
  botModelSelection.instanceId === threadModelSelection.instanceId
    ? botModelSelection
    : threadModelSelection;

/**
 * The model selection for a turn the server starts on a bot's thread: a
 * delegated task, a group round, a retry or a restart continuation.
 *
 * Without it the turn carries no selection, the provider falls back to its
 * defaults, and a bot set to a high reasoning effort runs at the provider's
 * default (Codex: medium). It is read at turn time, so a bot edited after its
 * thread was created gets the new setting, the same as a typed message.
 *
 * Returns undefined for a thread that is not a bot chat, and treats a failed
 * lookup the same way: the turn still runs, as it did before.
 */
export const botModelSelectionForThread = (
  bots: PersonalBotRepository.PersonalBotRepository["Service"],
  threadId: ThreadId,
  threadModelSelection: ModelSelection | undefined,
): Effect.Effect<ModelSelection | undefined> =>
  Effect.gen(function* () {
    const link = yield* bots.getThreadLink({ threadId });
    if (Option.isNone(link)) return undefined;
    const bot = yield* bots.getBotById({ botId: link.value.botId });
    if (Option.isNone(bot)) return undefined;
    return threadModelSelection === undefined
      ? bot.value.modelSelection
      : sendModelSelection(bot.value.modelSelection, threadModelSelection);
  }).pipe(Effect.orElseSucceed(() => undefined));
