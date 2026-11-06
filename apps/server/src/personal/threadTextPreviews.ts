/**
 * Whole-text reads for the personal `threadFullText` RPC.
 *
 * U's thread snapshots are already bounded, so the preview trimming that this
 * module used to apply on v1 is gone. Only the read behind an expanded row
 * remains, served from the v2 message and turn-item projections.
 *
 * @module personal/threadTextPreviews
 */
import type { PersonalThreadFullTextInput, PersonalThreadFullTextResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PersonalEngine from "./engine/PersonalEngine.ts";

export const readThreadFullText = (input: PersonalThreadFullTextInput) =>
  Effect.gen(function* () {
    const engine = yield* PersonalEngine.PersonalEngine;
    const messageIds = input.messageIds ?? [];
    const activityIds = input.activityIds ?? [];
    const messages =
      messageIds.length === 0
        ? []
        : yield* engine
            .messagesByIds({ threadId: input.threadId, messageIds })
            .pipe(Effect.orElseSucceed(() => []));
    const activityRows =
      activityIds.length === 0
        ? []
        : yield* engine
            .activitiesByIds({ threadId: input.threadId, ids: activityIds })
            .pipe(Effect.orElseSucceed(() => []));
    return {
      messages: messages.map((message) => ({ messageId: message.id, text: message.text })),
      activities: activityRows.map((row) => ({ activityId: row.id, payload: row.payload })),
    } satisfies PersonalThreadFullTextResult;
  });
