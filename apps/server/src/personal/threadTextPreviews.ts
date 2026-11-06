/**
 * B1 placeholder for the text-preview reads. C2 moves them onto v2 turn items.
 *
 * The snapshot pass-through keeps the full text, which is the safe fallback
 * when previews are not computed. The full-text read dies by name so a call
 * that reaches it before C2 fails loudly.
 *
 * @module personal/threadTextPreviews
 */
import type { PersonalThreadFullTextInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const maybeApplyThreadTextPreviews = <S>(snapshot: S, _enabled: boolean): S => snapshot;

export const readThreadFullText = (input: PersonalThreadFullTextInput) =>
  Effect.die(`v2-port pending: personalBots.threadFullText ${input.threadId}`);
