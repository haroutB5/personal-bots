import type { ModelSelection, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderSessionPrewarmOutcome,
} from "../orchestration/Services/ProviderCommandReactor.ts";
import { PersonalGroupService } from "./groups/PersonalGroupService.ts";
import { PersonalBotRepository } from "./PersonalBotRepository.ts";
import { serverPerfOptimizationOn } from "./perfFlags.ts";

/** A chat reopened within this window is not prewarmed again. */
export const SESSION_PREWARM_DEBOUNCE_MS = 60_000;

/**
 * Prewarmed sessions nobody has sent to yet, at most. Each is a Claude Code
 * process (about 240 MB) that lives until the reaper stops it, so paging
 * through old chats must not start one per chat.
 */
export const SESSION_PREWARM_MAX_UNUSED = 3;

export type PersonalSessionPrewarmOutcome =
  | ProviderSessionPrewarmOutcome
  | "disabled"
  | "debounced"
  | "not-a-bot-chat"
  | "group-member"
  | "too-many-unused";

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
 * Opening a personal bot chat starts its Claude session in the background, so
 * the first message after a pause does not wait 1.5-2.6 s for it. No prompt is
 * sent and no turn starts; the session reaper stops it after the usual idle
 * window. Kill switch: PB_PERF_OFF=session-prewarm.
 */
export const makePersonalSessionPrewarmer = (options?: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly debounceMs?: number;
  readonly maxUnused?: number;
}) =>
  Effect.gen(function* () {
    const reactor = yield* ProviderCommandReactor;
    const bots = yield* PersonalBotRepository;
    const groups = yield* PersonalGroupService;
    const projection = yield* ProjectionSnapshotQuery;
    const debounceMs = options?.debounceMs ?? SESSION_PREWARM_DEBOUNCE_MS;
    const maxUnused = options?.maxUnused ?? SESSION_PREWARM_MAX_UNUSED;
    const lastAttemptMs = new Map<ThreadId, number>();
    /** Chats this prewarmer started a session for, with when. */
    const prewarmedAt = new Map<ThreadId, string>();

    /** Forgets prewarms that were used (a turn since) or whose session is gone. */
    const countUnused = Effect.gen(function* () {
      for (const [threadId, at] of prewarmedAt) {
        const thread = yield* projection.getThreadShellById(threadId);
        const unused =
          Option.isSome(thread) &&
          thread.value.session !== null &&
          thread.value.session.status !== "stopped" &&
          (thread.value.latestTurn === null || thread.value.latestTurn.requestedAt < at);
        if (!unused) prewarmedAt.delete(threadId);
      }
      return prewarmedAt.size;
    });

    const decide = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const link = yield* bots.getThreadLink({ threadId });
        if (Option.isNone(link)) return "not-a-bot-chat" as const;
        if (link.value.archivedAt !== null) return "archived" as const;
        if (Option.isSome(yield* groups.groupNameForMemberThread(threadId))) {
          return "group-member" as const;
        }
        const bot = yield* bots.getBotById({ botId: link.value.botId });
        if (Option.isNone(bot)) return "not-a-bot-chat" as const;
        const thread = yield* projection.getThreadShellById(threadId);
        if (Option.isNone(thread)) return "missing" as const;
        if ((yield* countUnused) >= maxUnused) return "too-many-unused" as const;
        const startedAt = DateTime.formatIso(yield* DateTime.now);
        const outcome = yield* reactor.prewarmSession({
          threadId,
          modelSelection: sendModelSelection(bot.value.modelSelection, thread.value.modelSelection),
        });
        if (outcome === "started") prewarmedAt.set(threadId, startedAt);
        return outcome;
      });

    const prewarm = (threadId: ThreadId): Effect.Effect<PersonalSessionPrewarmOutcome> =>
      Effect.gen(function* () {
        if (!serverPerfOptimizationOn("session-prewarm", options?.env)) return "disabled" as const;
        const now = yield* Clock.currentTimeMillis;
        const last = lastAttemptMs.get(threadId);
        if (last !== undefined && now - last < debounceMs) return "debounced" as const;
        lastAttemptMs.set(threadId, now);
        return yield* decide(threadId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("personal session prewarm failed", {
                  threadId,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as("failed" as const)),
          ),
        );
      });

    return { prewarm };
  });

export type PersonalSessionPrewarmer = Effect.Success<
  ReturnType<typeof makePersonalSessionPrewarmer>
>;
