/**
 * Starts a thread's provider session ahead of its next send, through the v2
 * session manager, without a turn and without a prompt. Opening a personal bot
 * chat then costs a session attach instead of a process start on the first
 * message.
 *
 * The session is opened on the chat's existing provider thread, so the next
 * turn finds the same provider session id and attaches to the live process. It
 * carries the bot's session instructions and personal facts, exactly as the
 * turn-start path passes them, so a prewarmed session answers as the bot.
 *
 * The services are looked up optionally. The websocket handler has all of them;
 * a narrower host (or a unit test) that does not gets `unsupported` instead of
 * a boot failure, and `PersonalProvidersV2Live` stays usable on its own.
 */
import type { ModelSelection, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { PersonalPrewarmOutcome } from "./PersonalProviders.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { RuntimePolicyV2 } from "../../orchestration-v2/RuntimePolicy.ts";
import { PersonalTurnContext } from "../turnContext/PersonalTurnContext.ts";

export class PersonalPrewarmSession extends Context.Service<
  PersonalPrewarmSession,
  {
    readonly prewarm: (input: {
      readonly threadId: ThreadId;
      readonly modelSelection: ModelSelection;
    }) => Effect.Effect<PersonalPrewarmOutcome>;
  }
>()("t3/personal/engine/PersonalPrewarmSession") {}

export const layerLive = Layer.effect(
  PersonalPrewarmSession,
  Effect.gen(function* () {
    const sessions = yield* Effect.serviceOption(ProviderSessionManagerV2);
    const projections = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
    const runtimePolicy = yield* Effect.serviceOption(RuntimePolicyV2);
    const turnContext = yield* Effect.serviceOption(PersonalTurnContext);

    const prewarm: PersonalPrewarmSession["Service"]["prewarm"] = (input) =>
      Effect.gen(function* () {
        if (
          Option.isNone(sessions) ||
          Option.isNone(projections) ||
          Option.isNone(runtimePolicy) ||
          Option.isNone(turnContext)
        ) {
          return "unsupported" as const;
        }
        const thread = yield* projections.value.getThread(input.threadId);
        const projection = yield* projections.value.getThreadRecords(input.threadId, [
          "providerThreads",
          "providerSessions",
        ]);
        if (thread.deletedAt !== null) return "missing" as const;
        if (thread.archivedAt !== null) return "archived" as const;
        const providerThread =
          projection.providerThreads.find(
            (candidate) => candidate.id === thread.activeProviderThreadId,
          ) ?? projection.providerThreads.at(-1);
        if (providerThread === undefined || providerThread.providerSessionId === null) {
          return "missing" as const;
        }
        const providerSessionId = providerThread.providerSessionId;
        if (yield* sessions.value.isLive(providerSessionId)) return "live" as const;
        const resolved = yield* runtimePolicy.value.resolve({
          thread,
          modelSelection: input.modelSelection,
        });
        const instructions = yield* turnContext.value.sessionInstructions(input.threadId);
        const personal = yield* turnContext.value.sessionPersonal(input.threadId);
        const existingSession = projection.providerSessions.find(
          (candidate) => candidate.id === providerSessionId,
        );
        const nativeId = providerThread.nativeThreadRef?.nativeId;
        yield* sessions.value.open({
          threadId: input.threadId,
          providerSessionId,
          modelSelection: input.modelSelection,
          runtimePolicy: resolved,
          ...(instructions._tag === "Some" ? { systemInstructions: instructions.value } : {}),
          ...(personal.personalBot
            ? {
                personal: {
                  personalBot: true as const,
                  ...(personal.personalBotId === undefined
                    ? {}
                    : { personalBotId: personal.personalBotId }),
                  personalTaskChat: personal.personalTaskChat,
                  ...(personal.secretEnvironment === undefined
                    ? {}
                    : { secretEnvironment: personal.secretEnvironment }),
                },
              }
            : {}),
          ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
          ...(nativeId == null ? {} : { initialNativeThreadId: nativeId }),
        });
        return "started" as const;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("personal session prewarm open failed", {
                threadId: input.threadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as("failed" as const)),
        ),
      );

    return { prewarm };
  }),
);

export const layer = layerLive;
