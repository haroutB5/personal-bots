import type { JSX } from "react";
import { useRef } from "react";

import type { PersonalBot } from "@t3tools/contracts";

import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";

import { BotAvatar } from "./BotAvatar";
import type { LeadConfirmCopy } from "./teamConstellationModel";

/**
 * "Make Frontend the Dev team lead?" Asked before a Lead drop replaces someone,
 * because it changes who delegates for the whole team. Nothing is sent until
 * the primary button; Cancel, Esc and a tap outside all leave the team as it is.
 * Focus starts on the primary button.
 */
export function TeamLeadConfirm({
  copy,
  newLead,
  oldLead,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly copy: LeadConfirmCopy;
  readonly newLead: PersonalBot;
  readonly oldLead: PersonalBot | null;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <SheetPopup
        side="bottom"
        role="alertdialog"
        showCloseButton={false}
        forceBackdrop
        initialFocus={confirmRef}
        backdropClassName="bg-black/[0.32] backdrop-blur-none dark:bg-black/[0.55]"
        className="personal-app mx-2 mb-[max(0.5rem,env(safe-area-inset-bottom))] max-h-[90dvh] w-auto rounded-[20px] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-5 pt-5 pb-3 text-[var(--personal-text)]"
      >
        <div aria-hidden="true" className="flex items-center justify-center gap-3">
          {oldLead === null ? null : (
            <>
              <BotAvatar
                shape={oldLead.avatarShape}
                color={oldLead.avatarColor}
                size={36}
                label=""
              />
              <span className="text-[var(--personal-text-secondary)]">→</span>
            </>
          )}
          <BotAvatar shape={newLead.avatarShape} color={newLead.avatarColor} size={40} label="" />
        </div>
        <SheetTitle className="mt-3 text-center text-[17px] leading-6 font-bold text-[var(--personal-text)]">
          {copy.title}
        </SheetTitle>
        <SheetDescription className="mt-1 space-y-1 text-center text-[15px] leading-5 text-[var(--personal-text-secondary)]">
          {copy.lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </SheetDescription>
        <div className="mt-4 flex flex-col gap-1">
          <button
            ref={confirmRef}
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="h-[50px] rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-base font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-surface)] disabled:opacity-40"
          >
            {copy.confirmLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="h-[50px] rounded-[var(--personal-radius-button)] text-base font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            Cancel
          </button>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
