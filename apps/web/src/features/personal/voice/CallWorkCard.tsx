/**
 * The work card: what the real bot is doing while the voice talks about it.
 * Two cards matter most and are the reason this exists rather than a caption:
 * the **Undo** card (the message the voice wants to send, held for 3 seconds
 * with a track that runs down) and the **bot is working** card, fed by the
 * chat's own progress line.
 *
 * Wording follows Harout's call (15 Oct): the send is the owner's own message,
 * so the card says what is being asked ("Asking CTO to:"), never that some
 * middle bot is relaying it.
 *
 * @module features/personal/voice/CallWorkCard
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";

import { BotAvatar } from "../BotAvatar";
import type { BotAvatarShape } from "../BotAvatar";
import { VOICE_UNDO_MS, type VoiceWorkCard, pendingSendTitle } from "./callState";

export function CallWorkCard({
  card,
  botName,
  shape,
  color,
  onUndo,
  onOpenChat,
}: {
  readonly card: VoiceWorkCard;
  readonly botName: string;
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly onUndo: () => void;
  readonly onOpenChat: () => void;
}): JSX.Element {
  // The Undo track runs down over the window: it starts full and is set to
  // empty one frame later, so the CSS transition does the timing.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setStarted(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const sending = card.kind === "sending";
  const tone =
    card.kind === "asking" || card.kind === "login"
      ? "review"
      : card.kind === "working"
        ? "live"
        : "plain";

  const line1 = sending
    ? pendingSendTitle(botName)
    : card.kind === "working"
      ? `${botName} is working`
      : card.kind === "replied"
        ? `${botName} replied`
        : card.kind === "asking"
          ? `${botName} is asking you`
          : `${botName} needs a password`;

  return (
    <section
      aria-live="polite"
      aria-label={sending ? "Message waiting to be sent" : `What ${botName} is doing`}
      data-voice-work={card.kind}
      className={`voice-call-card-in relative mx-4 mb-[18px] overflow-hidden rounded-[var(--personal-radius-card)] border px-3.5 py-3 ${
        tone === "review"
          ? "border-[var(--personal-review-border)] bg-[var(--personal-review-bg)]"
          : "border-[var(--personal-border)] bg-[var(--personal-surface)]"
      }`}
    >
      {sending ? (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
              {line1}
            </p>
            <p className="mt-1 line-clamp-2 text-[15px] leading-5 break-words text-[var(--personal-text)]">
              {card.detail}
            </p>
          </div>
          <button
            type="button"
            onClick={onUndo}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] px-4 text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.94]"
          >
            Undo
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpenChat}
          className="flex w-full items-start gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <BotAvatar shape={shape} color={color} size={32} label={botName} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              {card.kind === "working" ? (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full bg-[var(--personal-live)]"
                />
              ) : null}
              <span className="min-w-0 truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
                {line1}
              </span>
            </span>
            {card.detail.length > 0 ? (
              <span
                className={`mt-1 block ${
                  card.kind === "replied" || card.kind === "asking" ? "line-clamp-2" : "truncate"
                } text-[13px] leading-[18px] ${
                  card.kind === "asking" || card.kind === "login"
                    ? "text-[var(--personal-text-preview)]"
                    : "text-[var(--personal-text-secondary)]"
                }`}
              >
                {card.detail}
              </span>
            ) : null}
          </span>
        </button>
      )}

      {sending ? (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-[3px] bg-[var(--personal-track)]"
        >
          <div
            data-voice-undo-track=""
            className="h-full origin-left bg-[var(--personal-primary)]"
            style={{
              transform: started ? "scaleX(0)" : "scaleX(1)",
              transition: `transform ${VOICE_UNDO_MS}ms linear`,
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
