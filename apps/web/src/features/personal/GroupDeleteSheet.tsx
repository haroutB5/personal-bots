import type { JSX } from "react";
import { useState } from "react";

import type { PersonalBot } from "@t3tools/contracts";
import { Trash2 } from "lucide-react";

import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";

import { BotAvatar } from "./BotAvatar";
import { groupDeleteSummary, type GroupDeleteCandidate } from "./groupModel";

/**
 * The confirmation for the one irreversible act in a group: deleting it, and
 * optionally the member bots with every chat they have ever had.
 *
 * It names what is going before the destructive tap - each bot by name, and the
 * fact that its chats go with it - because nothing here can be undone. The
 * default ticks come from {@link groupDeleteCandidates}: a bot this group alone
 * holds starts ticked, and a team lead, a pinned bot or a bot that is in a
 * second group starts unticked **with the reason on its row**. Untick
 * everything and this is the plain "delete the group only" it has always been.
 *
 * Mounted only while it is open, so the default ticks are the initial state of
 * a fresh component rather than an effect. The group list refreshes on its own
 * behind this sheet; re-seeding from a refresh would silently re-tick a bot the
 * owner had just decided to keep.
 */
export function GroupDeleteSheet({
  groupName,
  candidates,
  botsById,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  readonly groupName: string;
  readonly candidates: ReadonlyArray<GroupDeleteCandidate>;
  readonly botsById: ReadonlyMap<string, PersonalBot>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onConfirm: (botIds: ReadonlyArray<string>) => void;
}): JSX.Element {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(candidates.filter((row) => row.checked).map((row) => row.botId)),
  );

  const chosen = candidates.filter((candidate) => ticked.has(candidate.botId));

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
        backdropClassName="bg-background/70 backdrop-blur-md"
        className="personal-app max-h-[90dvh] rounded-t-[var(--personal-radius-card)] border-[var(--personal-border)] bg-[var(--personal-surface)] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="px-5 pt-4">
          <SheetTitle className="text-[19px] leading-6 font-bold text-[var(--personal-text)]">
            Delete {groupName}?
          </SheetTitle>
          <SheetDescription className="mt-1 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
            The group conversation goes for good. Tick any bot you want deleted with it — its own
            chats, files and memories go too, and none of it comes back.
          </SheetDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-3">
          {candidates.length === 0 ? (
            <p className="py-2 text-[15px] text-[var(--personal-text-secondary)]">
              This group has no bots left in it.
            </p>
          ) : (
            <ul
              aria-label="Bots in this group"
              className="divide-y divide-[var(--personal-border)] rounded-[var(--personal-radius-card)] border border-[var(--personal-border)]"
            >
              {candidates.map((candidate) => {
                const bot = botsById.get(candidate.botId) ?? null;
                const checked = ticked.has(candidate.botId);
                return (
                  <li key={candidate.botId}>
                    <label className="flex min-h-14 w-full min-w-0 items-center gap-3 px-3.5 py-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={() =>
                          setTicked((current) => {
                            const next = new Set(current);
                            if (next.has(candidate.botId)) next.delete(candidate.botId);
                            else next.add(candidate.botId);
                            return next;
                          })
                        }
                        className="size-5 shrink-0"
                      />
                      {bot !== null ? (
                        <BotAvatar
                          shape={bot.avatarShape}
                          color={bot.avatarColor}
                          size={34}
                          label={bot.name}
                        />
                      ) : null}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium text-[var(--personal-text)]">
                          {candidate.name}
                        </span>
                        <span className="block truncate text-[13px] text-[var(--personal-text-secondary)]">
                          {candidate.reason ?? "Only in this group"}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {chosen.length > 0 ? (
            <p className="mt-3 text-[13px] leading-[18px] text-[var(--personal-danger)]">
              Deleting {chosen.map((candidate) => candidate.name).join(", ")} — every chat each of
              them has had goes with them.
            </p>
          ) : null}

          {error !== null ? (
            <p
              role="alert"
              className="mt-3 rounded-[var(--personal-radius-card)] border border-[var(--personal-danger-border)] bg-[var(--personal-danger-bg)] px-3.5 py-2.5 text-sm break-words text-[var(--personal-danger)]"
            >
              {error}
            </p>
          ) : null}
        </div>

        <div className="border-t border-[var(--personal-border)] px-5 py-3">
          <p
            aria-live="polite"
            className="pb-2 text-center text-[13px] text-[var(--personal-text-secondary)]"
          >
            {groupDeleteSummary(chosen.length)}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => onConfirm(chosen.map((candidate) => candidate.botId))}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-[var(--personal-radius-button)] bg-[var(--personal-destructive)] px-4 text-[15px] font-semibold text-[var(--personal-destructive-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-destructive)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)] disabled:opacity-50"
          >
            <Trash2 aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
            {busy
              ? "Deleting…"
              : chosen.length === 0
                ? "Delete group"
                : `Delete group and ${String(chosen.length)} ${chosen.length === 1 ? "bot" : "bots"}`}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="mt-1 h-11 w-full rounded-[var(--personal-radius-button)] text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
