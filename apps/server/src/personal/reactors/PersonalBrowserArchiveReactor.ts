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

import { PersonalBrowser } from "../browser/PersonalBrowser.ts";
import { PersonalEngine } from "../engine/PersonalEngine.ts";

export const PersonalBrowserArchiveReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* PersonalEngine;
    const browser = yield* PersonalBrowser;
    yield* Stream.runForEach(engine.events, (event) =>
      event._tag === "ThreadArchived"
        ? browser.releaseThread(event.threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("personal browser archive cleanup failed", {
                threadId: event.threadId,
                cause,
              }),
            ),
          )
        : Effect.void,
    ).pipe(Effect.forkScoped);
  }),
);
