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

import { PersonalBrowser } from "../../personal/browser/PersonalBrowser.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const ACTIVE_SESSION_STATUSES = new Set(["starting", "running"]);

export const PersonalBrowserTurnReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const browser = yield* PersonalBrowser;
    const events = yield* engine.subscribeDomainEvents;
    yield* Stream.runForEach(events, (event) =>
      event.type === "thread.session-set" &&
      !ACTIVE_SESSION_STATUSES.has(event.payload.session.status)
        ? browser.releaseLease(event.payload.threadId)
        : Effect.void,
    ).pipe(Effect.forkScoped);
  }),
);
