import type { JSX } from "react";

import type { PersonalBot } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";

import { BotAvatar } from "./BotAvatar";

export interface MemberListRow {
  readonly bot: PersonalBot;
  readonly modelLabel: string | null;
  readonly isLead: boolean;
  readonly live: boolean;
}

/**
 * Every bot on a team, lead first, with the whole name and the model label the
 * orbit has to cut short. It is also the way to move a bot without holding it:
 * each row has a Move button that opens the drop cards in tap mode. Opened from
 * the card's "N bots" button and from its "+N" seat.
 */
export function TeamMembersSheet({
  teamLabel,
  rows,
  onClose,
  onMove,
}: {
  readonly teamLabel: string;
  readonly rows: ReadonlyArray<MemberListRow>;
  readonly onClose: () => void;
  readonly onMove: (botId: string) => void;
}): JSX.Element {
  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetPopup
        side="bottom"
        showCloseButton={false}
        forceBackdrop
        backdropClassName="bg-black/[0.32] backdrop-blur-none dark:bg-black/[0.55]"
        className="personal-app max-h-[85dvh] rounded-t-[20px] border-[var(--personal-border)] bg-[var(--personal-surface)] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="px-5 pt-4">
          <SheetTitle className="text-[19px] leading-6 font-bold text-[var(--personal-text)]">
            {teamLabel}
          </SheetTitle>
          <SheetDescription className="mt-0.5 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
            {rows.length} {rows.length === 1 ? "bot" : "bots"}. Tap one to open it, or Move to put
            it on another team or in charge.
          </SheetDescription>
        </div>
        <ul className="mt-2 min-h-0 flex-1 divide-y divide-[var(--personal-border)] overflow-y-auto overscroll-contain px-5 pb-3">
          {rows.map((row) => (
            <li key={row.bot.botId} className="flex min-h-[60px] items-center gap-1">
              <Link
                to="/bots/$botId"
                params={{ botId: row.bot.botId }}
                className="flex min-h-[60px] min-w-0 flex-1 items-center gap-3 rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
              >
                <BotAvatar
                  shape={row.bot.avatarShape}
                  color={row.bot.avatarColor}
                  size={36}
                  label=""
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 text-[15px] leading-5 font-semibold break-words text-[var(--personal-text)]">
                      {row.bot.name}
                    </span>
                    {row.isLead ? (
                      <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-[var(--personal-primary)] px-[7px] text-[11px] leading-none font-semibold text-[var(--personal-primary-text)]">
                        Lead
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`block truncate text-[13px] leading-[18px] ${
                      row.live
                        ? "font-semibold text-[var(--personal-team-live)]"
                        : "text-[var(--personal-text-secondary)]"
                    }`}
                  >
                    {row.live ? "Working now" : (row.modelLabel ?? row.bot.title)}
                  </span>
                </span>
              </Link>
              <button
                type="button"
                onClick={() => onMove(row.bot.botId)}
                aria-label={`Move ${row.bot.name}`}
                className="min-h-11 min-w-11 shrink-0 rounded-[var(--personal-radius-button)] px-3 text-[15px] font-medium text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
              >
                Move
              </button>
            </li>
          ))}
        </ul>
      </SheetPopup>
    </Sheet>
  );
}
