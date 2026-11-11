import type { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type * as PersonalPushService from "./PersonalPushService.ts";

/**
 * What a socket does when its session moves to a successor: the push handlers
 * read the new session, and the rows the old one registered follow it.
 */
export const followSocketSession =
  (
    socketSession: Ref.Ref<AuthSessionId>,
    push: Pick<PersonalPushService.PersonalPushService["Service"], "followSession">,
  ) =>
  (from: AuthSessionId, to: AuthSessionId): Effect.Effect<void> =>
    Ref.set(socketSession, to).pipe(Effect.andThen(push.followSession(from, to)));
