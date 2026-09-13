import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { personalSecretEnvVar, type PersonalBotId, type ThreadId } from "@t3tools/contracts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import { personalBotSystemInstructions } from "../personalBotInstructions.ts";
import * as PersonalSecretRepository from "./PersonalSecretRepository.ts";
import { personalSecretStoreKey } from "./PersonalSecretService.ts";

/** What a provider session on one thread gets for being a personal bot's thread. */
export interface PersonalSessionGrant {
  /** The bot the thread belongs to; null for every non-personal thread. */
  readonly botId: PersonalBotId | null;
  /**
   * `PB_SECRET_<NAME>` for each fulfilled secret the bot requested, plus
   * every shared one. Read from the secret store when the session starts.
   */
  readonly environment: Readonly<Record<string, string>>;
  /**
   * The bot's own instructions followed by the app rules, built exactly as
   * the orchestration reactor builds them. ProviderService passes it when it
   * resumes a session outside the reactor (recovery after a restart); fresh
   * starts keep the reactor's own. Null for non-personal threads, a deleted
   * bot, or a failed lookup.
   */
  readonly systemInstructions: string | null;
}

const NONE: PersonalSessionGrant = { botId: null, environment: {}, systemInstructions: null };

/**
 * The narrow hook ProviderService consults when it starts a provider session:
 * whether the thread is a personal bot's (the "bots" MCP capability), which
 * secrets reach its process environment, and the bot's session instructions.
 * Never fails: a lookup error grants nothing.
 */
export class PersonalSessionAccess extends Context.Service<
  PersonalSessionAccess,
  {
    readonly forThread: (threadId: ThreadId) => Effect.Effect<PersonalSessionGrant>;
  }
>()("t3/personal/secrets/PersonalSessionAccess") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const secrets = yield* PersonalSecretRepository.PersonalSecretRepository;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const decoder = new TextDecoder();

  /** Isolated so a failed instructions read never costs the thread its secrets or grant. */
  const instructionsForThread = (threadId: ThreadId) =>
    bots.getInstructionsForThread({ threadId }).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: personalBotSystemInstructions,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("personal bot instructions lookup failed; starting without them", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null)),
      ),
    );

  const forThread: PersonalSessionAccess["Service"]["forThread"] = (threadId) =>
    Effect.gen(function* () {
      const link = yield* bots.getThreadLink({ threadId });
      if (Option.isNone(link)) {
        return NONE;
      }
      const botId = link.value.botId;
      const fulfilled = yield* secrets.listByStatus("fulfilled");
      const names = new Set(
        fulfilled
          .filter((entry) => entry.botId === botId || entry.shared)
          .map((entry) => entry.name),
      );
      const environment: Record<string, string> = {};
      for (const name of names) {
        const value = yield* store.get(personalSecretStoreKey(name)).pipe(
          Effect.catch(() =>
            // The name only: the value is never logged.
            Effect.logWarning("personal secret unreadable; starting the session without it", {
              name,
            }).pipe(Effect.as(Option.none<Uint8Array>())),
          ),
        );
        if (Option.isSome(value)) {
          environment[personalSecretEnvVar(name)] = decoder.decode(value.value);
        }
      }
      const systemInstructions = yield* instructionsForThread(threadId);
      return { botId, environment, systemInstructions } satisfies PersonalSessionGrant;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("personal session access lookup failed; granting nothing", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(NONE)),
      ),
    );

  return { forThread } satisfies PersonalSessionAccess["Service"];
});

export const layer = Layer.effect(PersonalSessionAccess, make);

/** Self-contained: brings its own (stateless, SQL/file-backed) repositories and store. */
export const layerLive = layer.pipe(
  Layer.provide(PersonalBotRepository.layer),
  Layer.provide(PersonalSecretRepository.layer),
  Layer.provide(ServerSecretStore.layer),
);
