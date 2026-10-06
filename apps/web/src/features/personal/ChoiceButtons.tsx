import type { JSX } from "react";
import { useRef, useState } from "react";

import { Check } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * Where a set of choices stands. `open`: the latest reply's, tappable unless
 * the chat is busy. `used`: the owner sent something after it, so the set is
 * greyed out; `picked` is the option that message was, when it was one.
 */
export type ChoicesState =
  | { readonly kind: "open"; readonly disabled: boolean }
  | { readonly kind: "used"; readonly picked: string | null };

/**
 * A bot's tap-to-answer options (`splitChoices`), as buttons in the chip and
 * card style. A tap sends the option as the owner's own message through
 * `onChoose`, once: a second tap while the first is on its way does nothing,
 * and a send that fails frees the set again.
 */
export function ChoiceButtons({
  options,
  state,
  botName,
  onChoose,
}: {
  options: ReadonlyArray<string>;
  state: ChoicesState;
  botName: string;
  /** Resolves true once the message was sent. */
  onChoose: ((text: string) => Promise<boolean>) | undefined;
}): JSX.Element {
  const [sent, setSent] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const used = state.kind === "used";
  const picked = used ? state.picked : sent;
  const locked = used || sent !== null || state.disabled || onChoose === undefined;

  const choose = (option: string) => {
    if (locked || sendingRef.current || onChoose === undefined) return;
    sendingRef.current = true;
    setSent(option);
    void onChoose(option)
      .then((ok) => {
        if (ok) return;
        sendingRef.current = false;
        setSent(null);
      })
      .catch(() => {
        sendingRef.current = false;
        setSent(null);
      });
  };

  return (
    <div
      role="group"
      aria-label={`Quick answers for ${botName}`}
      data-testid="choices"
      data-state={used || sent !== null ? "used" : locked ? "disabled" : "open"}
      className="mt-2.5 flex flex-wrap gap-2"
    >
      {options.map((option) => {
        const isPicked = picked === option;
        return (
          <button
            key={option}
            type="button"
            disabled={locked}
            aria-pressed={isPicked}
            onClick={() => choose(option)}
            className={cn(
              "flex min-h-11 max-w-full min-w-0 items-center gap-1.5 rounded-[var(--personal-radius-button)] border px-3.5 py-2 text-left text-[15px] leading-snug font-medium break-words outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]",
              isPicked
                ? "border-[var(--personal-text-secondary)] bg-[var(--personal-fill-muted)] text-[var(--personal-text)]"
                : "border-[var(--personal-border)] bg-[var(--personal-surface)] text-[var(--personal-text)]",
              // A used or busy set is quiet, not hidden: it still reads as what was offered.
              locked && !isPicked && "opacity-40",
              locked && "cursor-default",
            )}
          >
            {isPicked ? (
              <Check aria-hidden="true" className="size-4 shrink-0" strokeWidth={2.25} />
            ) : null}
            <span className="min-w-0">{option}</span>
          </button>
        );
      })}
    </div>
  );
}
