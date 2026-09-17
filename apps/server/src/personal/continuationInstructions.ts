import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ThreadId } from "@t3tools/contracts";

import type * as PersonalBotRepository from "./PersonalBotRepository.ts";
import { personalBotSystemInstructions } from "./personalBotInstructions.ts";

/**
 * The bot's persona for a turn nobody typed: a retry after a failed reply, or
 * the continuation of a turn a server restart interrupted.
 *
 * A personal bot's persona is set when its session starts, but some adapters
 * take it per turn, so a continuation that omits it answers as the raw model
 * instead of as the bot. Both continuation paths read it from here so they
 * cannot drift apart again.
 *
 * Takes the repository rather than requiring it from the context: the startup
 * path resolves it optionally (a server built without the personal stack still
 * continues its turns), and neither caller should gain a requirement.
 *
 * Returns undefined for a thread that is not a bot chat, and treats a failed
 * lookup the same way: a continuation that answers is better than one that
 * fails, and the caller already logs the turn's outcome.
 */
export const continuationSystemInstructions = (
  bots: PersonalBotRepository.PersonalBotRepository["Service"],
  threadId: ThreadId,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const persona = yield* bots
      .getInstructionsForThread({ threadId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.isSome(persona) ? personalBotSystemInstructions(persona.value) : undefined;
  });
