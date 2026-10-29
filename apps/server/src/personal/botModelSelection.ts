import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ModelSelection, ThreadId } from "@t3tools/contracts";

import * as PersonalModelFallback from "./PersonalModelFallbackService.ts";
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
 * A bot on a usage-limit fallback runs its turns on the fallback model until
 * the row ends. A bot that stays busy on a task never goes idle, so the idle
 * switch-back sweep cannot end it; when a turn is about to start on a chat
 * that is between turns, the fallback service gets to end the row there
 * (1.66.104). The selection is then read again, so this turn already runs on
 * the bot's own model. A chat with a turn running is left alone.
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
    const found = yield* bots.getBotById({ botId: link.value.botId });
    if (Option.isNone(found)) return undefined;
    let bot = found.value;
    // A bot on its usage-limit fallback runs its turns on the fallback model,
    // whatever provider the chat's old session was on; its saved model comes
    // back when the fallback ends (the reactor then moves the chat again).
    if (bot.fallbackActive !== undefined) {
      const modelFallback = yield* Effect.serviceOption(
        PersonalModelFallback.PersonalModelFallback,
      );
      if (Option.isSome(modelFallback)) {
        yield* modelFallback.value.switchBackAtTurnBoundary({ botId: bot.botId, threadId });
        // The row may have ended: read the bot again so this turn sees it.
        const after = yield* bots.getBotById({ botId: bot.botId });
        if (Option.isSome(after)) bot = after.value;
      }
    }
    const fallback = bot.fallbackActive?.modelSelection;
    if (fallback !== undefined) return fallback;
    return threadModelSelection === undefined
      ? bot.modelSelection
      : sendModelSelection(bot.modelSelection, threadModelSelection);
  }).pipe(Effect.orElseSucceed(() => undefined));
