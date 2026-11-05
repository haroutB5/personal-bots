/**
 * A finished bot turn gives up the shared browser lease, so the browser queue
 * moves at the end of a reply instead of waiting out the 90 s agent TTL
 * (SPEC.md 10.5). A separate reactor rather than a subscription inside
 * PersonalBrowser: the browser layer must not depend on the orchestration
 * engine, which would close a layer cycle through the provider runtime.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { PersonalBrowser } from "../browser/PersonalBrowser.ts";
import { PersonalEngine } from "../engine/PersonalEngine.ts";

const ACTIVE_SESSION_STATUSES = new Set(["starting", "running"]);

export const PersonalBrowserTurnReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* PersonalEngine;
    const browser = yield* PersonalBrowser;
    yield* Stream.runForEach(engine.events, (event) =>
      event._tag === "StatusChanged" && !ACTIVE_SESSION_STATUSES.has(event.status)
        ? browser.releaseLease(event.threadId)
        : Effect.void,
    ).pipe(Effect.forkScoped);
  }),
);
