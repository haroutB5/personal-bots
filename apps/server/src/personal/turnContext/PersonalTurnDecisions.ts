/**
 * The personal decisions a client command makes before it becomes a turn: the
 * bot's current model selection and whether its first message may name the
 * chat.
 *
 * A client can hold a selection from before the owner edited the bot, and its
 * composer always sends a title seed. Both decisions belong to the personal
 * layer, so the command boundary asks this port instead of trusting the wire.
 *
 * @module personal/turnContext/PersonalTurnDecisions
 */
import type { MessageId, ModelSelection, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { botModelSelectionForThread } from "../botModelSelection.ts";
import { PersonalEngine } from "../engine/PersonalEngine.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import { uniqueAutomaticTitle } from "../personalChatTitles.ts";
import { personalTitleSeedForSend } from "../personalThreadTitles.ts";

export interface PersonalTurnDecisionsShape {
  /** The bot's own selection for a bot chat; undefined for any other thread. */
  readonly modelSelection: (input: {
    readonly threadId: ThreadId;
    readonly threadModelSelection: ModelSelection | undefined;
  }) => Effect.Effect<ModelSelection | undefined>;
  /** The seed the chat may take, made unique for the bot, or undefined. */
  readonly titleSeed: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly titleSeed: string;
  }) => Effect.Effect<string | undefined>;
}

export class PersonalTurnDecisions extends Context.Reference<PersonalTurnDecisionsShape>(
  "t3/personal/turnContext/PersonalTurnDecisions",
  {
    defaultValue: () => ({
      modelSelection: () => Effect.succeed(undefined),
      titleSeed: (input) => Effect.succeed(input.titleSeed),
    }),
  },
) {}

export const layer = Layer.effect(
  PersonalTurnDecisions,
  Effect.gen(function* () {
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const engine = yield* Effect.serviceOption(PersonalEngine);

    return {
      modelSelection: (input) =>
        botModelSelectionForThread(bots, input.threadId, input.threadModelSelection),
      titleSeed: (input) =>
        Effect.gen(function* () {
          if (Option.isNone(engine)) return input.titleSeed;
          const thread = yield* engine.value
            .getThread(input.threadId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(thread)) return input.titleSeed;
          const seed = personalTitleSeedForSend({
            title: thread.value.title,
            titleState: thread.value.titleState,
            messageId: input.messageId,
            titleSeed: input.titleSeed,
          });
          if (seed === undefined) return undefined;
          return yield* uniqueAutomaticTitle(bots, { threadId: input.threadId, title: seed });
        }),
    };
  }),
);
