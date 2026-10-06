import type { JSX } from "react";
import { useRef, useState } from "react";

import { Sheet, SheetPopup, SheetTitle } from "~/components/ui/sheet";

import { snoozePresets, type SnoozePreset } from "./chatState";

const OPTION_CLASS =
  "flex min-h-12 w-full items-center justify-between gap-3 rounded-[var(--personal-radius-button)] px-4 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40 personal-row-hover";

/** The choices and Cancel. The sheet around them is below; this part is the content. */
export function SnoozePresetList({
  presets,
  onPick,
  onCancel,
  firstRef,
}: {
  readonly presets: ReadonlyArray<SnoozePreset>;
  readonly onPick: (preset: SnoozePreset) => void;
  readonly onCancel: () => void;
  readonly firstRef?: React.Ref<HTMLButtonElement> | undefined;
}): JSX.Element {
  return (
    <div className="mt-3 flex flex-col gap-1">
      {presets.map((preset, index) => (
        <button
          key={preset.key}
          ref={index === 0 ? firstRef : undefined}
          type="button"
          data-snooze-preset={preset.key}
          aria-label={`${preset.label}, ${preset.detail}`}
          onClick={() => onPick(preset)}
          className={OPTION_CLASS}
        >
          <span className="text-base font-semibold text-[var(--personal-text)]">
            {preset.label}
          </span>
          <span className="text-[14px] text-[var(--personal-text-secondary)]">{preset.detail}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={onCancel}
        className="mt-1 h-[50px] rounded-[var(--personal-radius-button)] text-base font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      >
        Cancel
      </button>
    </div>
  );
}

/**
 * "Snooze" asks when the chat should come back: a bottom sheet with the
 * presets (`snoozePresets`). Mount it while it is open; the times are worked
 * out when it opens, so "In 1 hour" is an hour from the tap that opened it.
 */
export function SnoozeSheet({
  title = "Snooze until",
  onPick,
  onCancel,
}: {
  readonly title?: string;
  readonly onPick: (untilMs: number) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [presets] = useState(() => snoozePresets(new Date()));
  const firstRef = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <SheetPopup
        side="bottom"
        role="dialog"
        showCloseButton={false}
        forceBackdrop
        initialFocus={firstRef}
        backdropClassName="bg-black/[0.32] backdrop-blur-none dark:bg-black/[0.55]"
        className="personal-app mx-2 mb-[max(0.5rem,env(safe-area-inset-bottom))] max-h-[90dvh] w-auto rounded-[20px] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 pt-5 pb-3 text-[var(--personal-text)]"
      >
        <SheetTitle className="px-1 text-center text-[17px] leading-6 font-bold text-[var(--personal-text)]">
          {title}
        </SheetTitle>
        <SnoozePresetList
          presets={presets}
          firstRef={firstRef}
          onCancel={onCancel}
          onPick={(preset) => onPick(preset.untilMs)}
        />
      </SheetPopup>
    </Sheet>
  );
}
