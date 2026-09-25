/**
 * ProviderCommandReactor - Provider command reaction service interface.
 *
 * Owns background workers that react to orchestration intent events and
 * dispatch provider-side command execution.
 *
 * @module ProviderCommandReactor
 */
import type { ModelSelection, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ProviderCommandReactorShape - Service API for provider command reactors.
 */
export interface ProviderCommandReactorShape {
  /**
   * Start reacting to provider-intent orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   * It subscribes before returning. Event handling waits for server activation.
   *
   * Filters orchestration domain events to provider-intent types before
   * processing.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;

  /**
   * Starts, or resumes, a thread's provider session ahead of its next send,
   * without a turn and without a prompt, so that send skips the session start.
   * Serialised with the thread's other session starts. Does nothing when a
   * session is already live or the thread cannot take one (missing, archived,
   * compacting, in a worktree, or not a Claude thread).
   */
  readonly prewarmSession: (input: {
    readonly threadId: ThreadId;
    /** What the next send will ask for, so that send reuses the session. */
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderSessionPrewarmOutcome>;
}

export type ProviderSessionPrewarmOutcome =
  | "started"
  | "live"
  | "missing"
  | "archived"
  | "busy"
  | "unsupported"
  | "failed";

/**
 * ProviderCommandReactor - Service tag for provider command reaction workers.
 */
export class ProviderCommandReactor extends Context.Service<
  ProviderCommandReactor,
  ProviderCommandReactorShape
>()("t3/orchestration/Services/ProviderCommandReactor") {}
