/**
 * The call button inside the composer field (spec 2, entry B): the voice-mode
 * spot people know from ChatGPT, Claude and Gemini. It is the only part of the
 * voice feature on the chat's startup path, so it imports nothing heavier than
 * the context and one icon; the engine and the worklet are fetched on the tap.
 *
 * Rules:
 * - shown when the draft is empty, the chat is writable and the bot allows calls;
 * - hidden while typing, so it never steals typing room;
 * - green while a call with this bot is on; hidden while a call with another
 *   bot runs (the call bar is the way back to that one).
 *
 * @module features/personal/voice/ComposerCallButton
 */
import type { JSX } from "react";

import { Phone } from "lucide-react";

import { preloadVoiceCall, useVoiceCall } from "./VoiceCallProvider";

export function ComposerCallButton({
  threadId,
  botId,
  botName,
  avatarShape,
  avatarColor,
  /** False when the draft has anything in it. */
  visible,
  disabled = false,
}: {
  readonly threadId: string;
  readonly botId: string;
  readonly botName: string;
  readonly avatarShape: string;
  readonly avatarColor: string;
  readonly visible: boolean;
  readonly disabled?: boolean;
}): JSX.Element | null {
  const voice = useVoiceCall();
  if (voice === null || !visible) return null;
  const call = voice.call;
  const onThisCall = call !== null && call.threadId === threadId;
  if (call !== null && !onThisCall) return null;

  const label = onThisCall ? `Back to the call with ${botName}` : `Call ${botName}`;
  return (
    <button
      type="button"
      data-composer-call=""
      // Fetch the engine while the finger is still down, so the tap is instant.
      onPointerDown={preloadVoiceCall}
      onClick={() => {
        if (onThisCall) {
          voice.setMinimised(false);
          return;
        }
        void voice.start({ threadId, botId, botName, avatarShape, avatarColor });
      }}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40 ${
        onThisCall ? "text-[var(--personal-live)]" : "text-[var(--personal-text)]"
      }`}
    >
      <Phone aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
    </button>
  );
}
