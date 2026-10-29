import { X } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { Sheet, SheetClose, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";
import { useMediaQuery } from "~/hooks/useMediaQuery";

import { useSheetDragDismiss } from "../useSheetDragDismiss";
import { ICON_STROKE } from "./ComputerSourceRow";

/** Wide enough for the 420 px drawer to sit beside the Computer page. */
export const DRAWER_QUERY = "(min-width: 900px)";

/**
 * A full-height bottom sheet on the phone (top at 150 px, grabber, drag to
 * dismiss) and a 420 px drawer from the right on a wide screen. Mount it while
 * it is open.
 */
export function ComputerSheet(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly toolbar?: ReactNode;
  readonly testId?: string;
}): JSX.Element {
  const drawer = useMediaQuery(DRAWER_QUERY);
  const dragRef = useSheetDragDismiss(props.onClose);
  return (
    <Sheet open onOpenChange={(next) => !next && props.onClose()}>
      <SheetPopup
        ref={drawer ? undefined : dragRef}
        side={drawer ? "right" : "bottom"}
        showCloseButton={false}
        forceBackdrop
        backdropClassName="bg-black/[0.32] backdrop-blur-none dark:bg-black/[0.55]"
        className={cn(
          "personal-app bg-[var(--personal-surface)] text-[var(--personal-text)] border-[var(--personal-border)]",
          drawer
            ? "h-full w-[420px] max-w-[420px] rounded-none"
            : "h-[calc(100dvh-150px)] rounded-t-[16px] pb-[env(safe-area-inset-bottom)]",
        )}
        data-testid={props.testId}
      >
        {drawer ? null : (
          <div
            data-sheet-drag-zone=""
            aria-hidden="true"
            className="flex h-[17px] shrink-0 touch-none justify-center pt-2"
          >
            <span className="h-[5px] w-9 rounded-full bg-[var(--personal-border-strong)]" />
          </div>
        )}
        <div
          data-sheet-drag-zone=""
          className="flex shrink-0 touch-none items-center gap-3 py-1.5 pr-3 pl-5"
        >
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-[19px] leading-6 font-bold">
              {props.title}
            </SheetTitle>
            {props.subtitle === undefined ? null : (
              <SheetDescription className="truncate text-[14px] leading-5 text-[var(--personal-text-secondary)]">
                {props.subtitle}
              </SheetDescription>
            )}
          </div>
          <SheetClose
            aria-label="Close"
            className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <X aria-hidden="true" className="size-[22px]" strokeWidth={ICON_STROKE} />
          </SheetClose>
        </div>
        {props.toolbar}
        <div className="personal-scroll-quiet flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-5 pt-1 pb-5">
          {props.children}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
