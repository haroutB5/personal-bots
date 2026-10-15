/**
 * The "From the call" tag: the marker the server puts on a message the voice
 * sent to the bot during a voice call.
 *
 * The message itself reads as the owner's own normal message (the bot answers it
 * like a typed one), so without this the transcript gives no sign that it was
 * spoken. The marker carries only the call id and where it came from; the
 * payload is never rendered.
 *
 * @module features/personal/voice/voiceCallMessage
 */
import {
  type OrchestrationMessageContext,
  PERSONAL_VOICE_CALL_CONTEXT_KIND,
  type PersonalVoiceCallMessageMarker,
  PersonalVoiceCallMessageMarker as MarkerSchema,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The tag's one line, used by the chat and by the tests. */
export const VOICE_CALL_TAG_LABEL = "From the call";

const decodeMarker = Schema.decodeUnknownOption(MarkerSchema);

/**
 * The call marker on a message, or null for anything not sent by a call. A
 * message with no context, or with context records of other kinds, is null.
 */
export function readVoiceCallMarker(
  context: OrchestrationMessageContext | undefined,
): PersonalVoiceCallMessageMarker | null {
  for (const record of context?.records ?? []) {
    if (record.kind !== PERSONAL_VOICE_CALL_CONTEXT_KIND || !("payload" in record)) continue;
    const marker = decodeMarker(record.payload);
    return Option.isSome(marker) ? marker.value : null;
  }
  return null;
}
