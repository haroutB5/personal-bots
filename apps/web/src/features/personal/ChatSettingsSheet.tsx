import type { JSX, ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ChevronLeft,
  MessageSquareDot,
  NotebookPen,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";

import { Sheet, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

import {
  type ChatSettingsHeader,
  type ChatSettingsRow,
  type ChatSettingsRowId,
} from "./chatSettingsModel";
import { snoozePresets, type SnoozePreset } from "./chatState";
import { SnoozePresetList } from "./SnoozeSheet";

const ROW_CLASS =
  "flex min-h-12 w-full items-center gap-3 rounded-[var(--personal-radius-button)] px-4 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] personal-row-hover";

const ICONS: Record<ChatSettingsRowId, typeof Pin> = {
  pin: Pin,
  unpin: PinOff,
  snooze: AlarmClock,
  wake: AlarmClock,
  markUnread: MessageSquareDot,
  rename: Pencil,
  wrapup: NotebookPen,
  archive: Archive,
  unarchive: ArchiveRestore,
  delete: Trash2,
};

/** The state dot in front of the meta line, drawn like the chip's own dot. */
function MetaDot({
  state,
}: {
  readonly state: NonNullable<ChatSettingsHeader["dot"]>;
}): JSX.Element {
  return <span aria-hidden="true" className="personal-chip-dot" data-state={state} />;
}

function Hairline(): JSX.Element {
  return <div aria-hidden="true" className="mx-1 my-1 h-px bg-[var(--personal-border)]" />;
}

function Header({ header }: { readonly header: ChatSettingsHeader }): JSX.Element {
  return (
    <div className="px-4 pb-3 text-left">
      <SheetTitle
        data-testid="chat-settings-title"
        className="flex gap-1.5 text-[17px] leading-[22px] font-bold text-[var(--personal-text)]"
      >
        {header.pinned ? (
          <Pin
            aria-hidden="true"
            className="mt-1 size-3.5 shrink-0 text-[var(--personal-text-secondary)]"
            strokeWidth={1.75}
          />
        ) : null}
        <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{header.title}</span>
      </SheetTitle>
      <p
        data-testid="chat-settings-meta"
        className={cn(
          "mt-0.5 flex items-center gap-1.5 text-[13px] leading-[18px]",
          header.dot === "needs_you"
            ? "text-[var(--personal-review-text)]"
            : "text-[var(--personal-text-secondary)]",
        )}
      >
        {header.dot === null ? null : <MetaDot state={header.dot} />}
        <span className="min-w-0 truncate">{header.meta}</span>
      </p>
      {header.preview === null ? null : (
        <p
          data-testid="chat-settings-preview"
          className="mt-0.5 truncate text-[13px] leading-[18px] text-[var(--personal-text-tertiary)]"
        >
          {header.preview}
        </p>
      )}
    </div>
  );
}

function RowButton({
  row,
  onSelect,
  firstRef,
}: {
  readonly row: ChatSettingsRow;
  readonly onSelect: (id: ChatSettingsRowId) => void;
  readonly firstRef?: RefObject<HTMLButtonElement | null> | undefined;
}): JSX.Element {
  const Icon = ICONS[row.id];
  const muted = row.disabled;
  return (
    <button
      ref={firstRef}
      type="button"
      data-chat-settings-row={row.id}
      aria-disabled={row.disabled ? true : undefined}
      onClick={() => {
        if (!row.disabled) onSelect(row.id);
      }}
      className={ROW_CLASS}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-5 shrink-0",
          row.destructive
            ? "text-[var(--personal-error)]"
            : muted
              ? "text-[var(--personal-text-tertiary)]"
              : "text-[var(--personal-text-secondary)]",
        )}
        strokeWidth={1.75}
      />
      <span
        className={cn(
          "min-w-0 flex-1 text-base leading-[21px] font-medium",
          row.destructive
            ? "text-[var(--personal-error)]"
            : muted
              ? "text-[var(--personal-text-tertiary)]"
              : "text-[var(--personal-text)]",
        )}
      >
        {row.label}
      </span>
      {row.detail === null ? null : (
        <span
          className={cn(
            "shrink-0 text-[14px]",
            muted
              ? "text-[var(--personal-text-tertiary)]"
              : "text-[var(--personal-text-secondary)]",
          )}
        >
          {row.detail}
        </span>
      )}
    </button>
  );
}

/**
 * What the sheet holds: the chat's header, its rows in groups, Cancel, and the
 * snooze step that swaps in for them. The sheet around it is below; this part
 * is the one with behaviour.
 */
export function ChatSettingsContent({
  header,
  groups,
  chatName,
  onSelect,
  onSnoozePick,
  onCancel,
  presets,
  firstRowRef: firstRowRefProp,
}: {
  readonly header: ChatSettingsHeader;
  readonly groups: ReadonlyArray<ReadonlyArray<ChatSettingsRow>>;
  /** The chat's name under "Snooze until". */
  readonly chatName: string;
  /** A row was chosen. Snooze is handled here (it swaps in place); every other row goes up. */
  readonly onSelect: (id: Exclude<ChatSettingsRowId, "snooze">) => void;
  readonly onSnoozePick: (untilMs: number) => void;
  readonly onCancel: () => void;
  /** The snooze choices (worked out when the sheet opens); tests pass their own. */
  readonly presets?: ReadonlyArray<SnoozePreset> | undefined;
  /** Goes on the first enabled row: where the sheet puts focus when it opens. */
  readonly firstRowRef?: RefObject<HTMLButtonElement | null> | undefined;
}): JSX.Element {
  const [step, setStep] = useState<"rows" | "snooze">("rows");
  const [presetList] = useState(() => presets ?? snoozePresets(new Date()));
  const ownFirstRowRef = useRef<HTMLButtonElement | null>(null);
  const firstRowRef = firstRowRefProp ?? ownFirstRowRef;
  const firstPresetRef = useRef<HTMLButtonElement | null>(null);
  const snoozeRowRef = useRef<HTMLButtonElement | null>(null);
  // Focus follows the swap: the first choice going in, the Snooze row coming back.
  const lastStep = useRef(step);
  useEffect(() => {
    if (lastStep.current === step) return;
    lastStep.current = step;
    (step === "snooze" ? firstPresetRef : snoozeRowRef).current?.focus();
  }, [step]);

  if (step === "snooze") {
    return (
      <div data-chat-settings-step="snooze" className="personal-sheet-step">
        <div className="flex items-center gap-1 pb-1">
          <button
            type="button"
            aria-label="Back to chat settings"
            onClick={() => setStep("rows")}
            className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </button>
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-[17px] leading-[22px] font-bold text-[var(--personal-text)]">
              Snooze until
            </SheetTitle>
            <p className="truncate text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
              {chatName}
            </p>
          </div>
        </div>
        <SnoozePresetList
          presets={presetList}
          firstRef={firstPresetRef}
          onCancel={onCancel}
          onPick={(preset) => onSnoozePick(preset.untilMs)}
        />
      </div>
    );
  }

  const firstEnabledId = groups.flat().find((entry) => !entry.disabled)?.id;
  const sections: ReactNode[] = [];
  groups.forEach((group, index) => {
    // A group is named by its first row: the rows never repeat between groups.
    const groupKey = group[0]?.id ?? String(index);
    if (index > 0) sections.push(<Hairline key={`line-${groupKey}`} />);
    sections.push(
      <div key={`group-${groupKey}`} className="flex flex-col">
        {group.map((entry) => (
          <RowButton
            key={entry.id}
            row={entry}
            firstRef={
              entry.id === "snooze"
                ? snoozeRowRef
                : entry.id === firstEnabledId
                  ? firstRowRef
                  : undefined
            }
            onSelect={(id) => {
              if (id === "snooze") setStep("snooze");
              else onSelect(id);
            }}
          />
        ))}
      </div>,
    );
  });
  return (
    <div data-chat-settings-step="rows" className="personal-sheet-step">
      <Header header={header} />
      <Hairline />
      {sections}
      <button
        type="button"
        onClick={onCancel}
        className="mt-1 h-[50px] w-full rounded-[var(--personal-radius-button)] text-base font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      >
        Cancel
      </button>
    </div>
  );
}

/**
 * One chat's settings, in the snooze sheet's floating card. Mount it while it
 * is open. `returnFocusTo` is what held focus when it opened (the chip, the
 * header block or the menu button): focus goes back there when it closes.
 */
export function ChatSettingsSheet({
  returnFocusTo,
  ...content
}: {
  readonly returnFocusTo: RefObject<HTMLElement | null>;
} & Omit<Parameters<typeof ChatSettingsContent>[0], "presets" | "firstRowRef">): JSX.Element {
  const firstRowRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) content.onCancel();
      }}
    >
      <SheetPopup
        side="bottom"
        role="dialog"
        showCloseButton={false}
        forceBackdrop
        initialFocus={firstRowRef}
        finalFocus={returnFocusTo}
        backdropClassName="bg-black/[0.32] backdrop-blur-none dark:bg-black/[0.55]"
        className="personal-app mx-2 mb-[max(0.5rem,env(safe-area-inset-bottom))] max-h-[90dvh] w-auto overflow-y-auto rounded-[20px] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 pt-4 pb-3 text-[var(--personal-text)] md:mx-auto md:w-full md:max-w-[430px]"
      >
        <ChatSettingsContent {...content} firstRowRef={firstRowRef} />
      </SheetPopup>
    </Sheet>
  );
}
