import type { JSX } from "react";

import type { PersonalReplyQuote } from "@t3tools/contracts";
import { X } from "lucide-react";

/**
 * The small quote above a sent reply. Tapping it jumps to the original when it
 * is loaded (`onJump` decides; an original that is not loaded does nothing).
 * The same markup draws it before the server has echoed the message back.
 */
export function ReplyQuoteChip({
  quote,
  onJump,
}: {
  quote: PersonalReplyQuote;
  onJump?: ((messageId: string) => void) | undefined;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid="reply-quote"
      aria-label={`Reply to ${quote.name}: ${quote.excerpt}. Jump to the original`}
      onClick={() => onJump?.(quote.messageId)}
      className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg border-l-2 border-[var(--personal-text-tertiary)] bg-[var(--personal-bg)]/60 px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:opacity-70"
    >
      <span className="max-w-full truncate text-[12px] leading-4 font-semibold text-[var(--personal-text)]">
        {quote.name}
      </span>
      <span className="line-clamp-2 max-w-full text-[13px] leading-4.25 break-words text-[var(--personal-text-secondary)]">
        {quote.excerpt}
      </span>
    </button>
  );
}

/** The composer's "Replying to ..." bar, with the X that drops the quote. */
export function ReplyBar({
  quote,
  onCancel,
}: {
  quote: PersonalReplyQuote;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div
      data-testid="reply-bar"
      className="mb-2 flex min-h-11 items-center gap-1 rounded-xl border-l-2 border-[var(--personal-text-tertiary)] bg-[var(--personal-fill-muted)] pl-3"
    >
      <p className="min-w-0 flex-1 text-[13px] leading-[18px]">
        <span className="block truncate font-semibold text-[var(--personal-text)]">
          Replying to {quote.name}
        </span>
        <span className="block truncate text-[var(--personal-text-secondary)]">
          {quote.excerpt}
        </span>
      </p>
      <button
        type="button"
        aria-label="Cancel reply"
        onClick={onCancel}
        className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
      >
        <X aria-hidden="true" className="size-4" strokeWidth={2} />
      </button>
    </div>
  );
}
