/**
 * A deleted chat gives up everything that outlives it: the shared browser it
 * was driving and every voice-call card and open-call lease it owns.
 *
 * The browser lease is persisted, so without this the Computer screen keeps
 * naming a deleted chat and a restart reopens its page. Voice-call cards hold
 * the recorded words of a private call; they must not outlive their chat. This
 * reactor listens to the engine's `ThreadDeleted`, the one event every deletion
 * path emits (the owner's Delete, a bulk delete, a bot purge, a group member
 * removal), so no path can leave a transcript behind.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { PersonalBrowser } from "../browser/PersonalBrowser.ts";
import { PersonalEngine } from "../engine/PersonalEngine.ts";
import * as PersonalVoiceCallRepository from "../voiceCalls/PersonalVoiceCallRepository.ts";

export const PersonalThreadDeletionReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* PersonalEngine;
    const browser = yield* PersonalBrowser;
    const voiceCalls = yield* PersonalVoiceCallRepository.PersonalVoiceCallRepository;

    yield* Stream.runForEach(engine.events, (event) =>
      event._tag === "ThreadDeleted"
        ? Effect.gen(function* () {
            const threadId = event.threadId;
            yield* browser.releaseThread(threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("personal browser deletion cleanup failed", {
                  threadId,
                  cause,
                }),
              ),
            );
            const cards = yield* voiceCalls.deleteByThread(threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("personal voice call card deletion failed", {
                  threadId,
                  cause,
                }).pipe(Effect.as(0)),
              ),
            );
            const leases = yield* voiceCalls.deleteLeasesByThread(threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("personal voice call lease deletion failed", {
                  threadId,
                  cause,
                }).pipe(Effect.as(0)),
              ),
            );
            if (cards > 0 || leases > 0) {
              yield* Effect.logDebug("thread deletion removed voice call records", {
                threadId,
                cards,
                leases,
              });
            }
          })
        : Effect.void,
    ).pipe(Effect.forkScoped);
  }),
);
