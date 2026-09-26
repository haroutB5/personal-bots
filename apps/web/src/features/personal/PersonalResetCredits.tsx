import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, type JSX } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { useResetCredit } from "~/components/usage/UsageLimits";

import {
  resetCreditsExpiresIn,
  resetCreditsHeadline,
  type UsageCardResetCredits,
} from "./usagePresentation";

const PHONE_BUTTON = "max-sm:h-11 max-sm:text-[15px]";

/**
 * A provider's banked reset credits in the usage sheet, with Redeem and its
 * confirm. The redeem itself is upstream's (`useResetCredit`, the Limits tab's
 * hook): this is only the Bots look. Loaded lazily by the sheet, so the
 * upstream usage module never weighs on the Chats screen's first paint.
 *
 * Stays mounted after the last credit is spent, so the outcome can still be
 * read; it renders nothing only when there is neither a credit nor a message.
 */
export default function PersonalResetCredits({
  environmentId,
  title,
  resetCredits,
  now,
  onRedeemed,
}: {
  readonly environmentId: EnvironmentId;
  /** Provider name for the copy, "Claude" or "Codex". */
  readonly title: string;
  readonly resetCredits: UsageCardResetCredits;
  readonly now: number;
  /** Runs after every attempt, so the bars and the count catch up. */
  readonly onRedeemed: () => void;
}): JSX.Element | null {
  const { credits, input } = resetCredits;
  const { confirming, setConfirming, busy, status, redeem } = useResetCredit(environmentId, input);
  // Two taps inside one frame both see busy=false; the ref makes it one spend.
  const inFlightRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (credits.availableCount === 0 && status === null) return null;
  const expiresIn = resetCreditsExpiresIn(credits, now);

  const onConfirm = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await redeem();
    } finally {
      inFlightRef.current = false;
    }
    onRedeemed();
  };

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--personal-border)] pt-3">
      {credits.availableCount > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span className="text-[15px] leading-5 text-[var(--personal-text)] tabular-nums">
              {resetCreditsHeadline(credits.availableCount)}
            </span>
            {expiresIn !== null ? (
              <span className="text-[13px] leading-[18px] text-[var(--personal-text-secondary)] tabular-nums">
                {/* One unit: "26d 15h" must never break across lines. */}
                Next expires in <span className="whitespace-nowrap">{expiresIn}</span>
              </span>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            aria-busy={busy}
            aria-label={`Redeem a banked ${title} reset`}
            className="h-11 shrink-0 px-4 text-[15px] sm:h-11"
            onClick={() => setConfirming(true)}
          >
            {busy ? "Redeeming…" : "Redeem"}
          </Button>
        </div>
      ) : null}
      <p
        role="status"
        className="text-[13px] leading-snug text-[var(--personal-text)] empty:hidden"
      >
        {status}
      </p>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup
          initialFocus={cancelRef}
          className="personal-app max-w-lg border-[var(--personal-border)] bg-[var(--personal-surface)] text-[var(--personal-text)] max-sm:pb-[env(safe-area-inset-bottom)]"
        >
          <AlertDialogHeader className="text-left">
            <AlertDialogTitle className="text-[18px] leading-snug text-[var(--personal-text)]">
              {`Redeem a banked ${title} reset?`}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[15px] leading-snug text-[var(--personal-text-secondary)]">
              {`This uses one of your banked resets and clears the current ${title} limit windows now. It cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Redeeming cannot be undone, so Cancel is the filled, focused default.
              The footer stacks in reverse on a phone: Cancel sits on top there
              and on the right on desktop. */}
          <AlertDialogFooter className="border-[var(--personal-border)] bg-transparent">
            <Button
              variant="outline"
              className={PHONE_BUTTON}
              disabled={busy}
              onClick={() => void onConfirm()}
            >
              Redeem
            </Button>
            <AlertDialogClose render={<Button ref={cancelRef} className={PHONE_BUTTON} />}>
              Cancel
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
