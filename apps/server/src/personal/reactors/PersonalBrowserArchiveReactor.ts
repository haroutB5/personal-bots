/**
 * An archived chat gives up the shared browser, like a deleted one: its tabs
 * close, its help card goes and the "Back to chat" target stops naming it.
 * Without this an archived chat could keep a "needs you" card holding the
 * browser for good (QA's B6). A separate reactor for the same reason as the
 * turn reactor: the browser layer must not depend on the orchestration engine.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { PersonalBrowser } from "../../personal/browser/PersonalBrowser.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

export const PersonalBrowserArchiveReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const browser = yield* PersonalBrowser;
    const events = yield* engine.subscribeDomainEvents;
    yield* Stream.runForEach(events, (event) =>
      event.type === "thread.archived"
        ? browser.releaseThread(event.payload.threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("personal browser archive cleanup failed", {
                threadId: event.payload.threadId,
                cause,
              }),
            ),
          )
        : Effect.void,
    ).pipe(Effect.forkScoped);
  }),
);
