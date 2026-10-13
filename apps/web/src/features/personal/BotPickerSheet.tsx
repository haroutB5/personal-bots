import type { JSX } from "react";
import { useMemo, useState } from "react";

import { ThreadId, type EnvironmentId, type PersonalBotId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Search, X } from "lucide-react";

import { Sheet, SheetClose, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import type { BotSummary } from "./botSummaries";
import { commandFailureMessage } from "./commandFeedback";
import { personalBotCreateThread } from "./usePersonalBots";

/**
 * The header "+" opens this: pick a bot, and a new chat with it opens. One
 * tap from a bot to a chat, which is what the design asks for; the chat is
 * auto-titled from the first message, and the "New chat with <bot>" name sheet
 * stays on the bot's own page for when a name matters.
 *
 * The bottom rows keep New group and New bot reachable: New group had no other
 * entry point once the old "+" menu went (New bot also lives in Settings, so
 * its row is a shortcut, not the only way).
 */
export function BotPickerSheet({
  open,
  onOpenChange,
  environmentId,
  bots,
  now,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId | null;
  /** Bots that show in the chats list (group-only bots stay inside their groups). */
  readonly bots: ReadonlyArray<BotSummary>;
  readonly now: number;
}): JSX.Element {
  const navigate = useNavigate();
  const createThread = useAtomCommand(personalBotCreateThread, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [busyBotId, setBusyBotId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needle = query.trim().toLocaleLowerCase();
  const shown = useMemo(
    () =>
      needle.length === 0
        ? bots
        : bots.filter(
            (summary) =>
              summary.bot.name.toLocaleLowerCase().includes(needle) ||
              summary.bot.title.toLocaleLowerCase().includes(needle),
          ),
    [bots, needle],
  );

  const pick = async (botId: string) => {
    if (environmentId === null || busyBotId !== null) return;
    setBusyBotId(botId);
    setError(null);
    const threadId = ThreadId.make(randomUUID());
    const result = await createThread({
      environmentId,
      input: { botId: botId as PersonalBotId, threadId },
    });
    setBusyBotId(null);
    if (result._tag !== "Success") {
      setError(commandFailureMessage(result, "Couldn't start the chat. Try again.") ?? "");
      return;
    }
    // Gone before the chat opens: the list stays mounted under it.
    onOpenChange(false);
    await navigate({
      to: "/bots/$botId/$threadId",
      params: { botId: botId as PersonalBotId, threadId },
    });
  };

  const go = async (to: "/bots/new" | "/bots/groups/new") => {
    onOpenChange(false);
    await navigate({ to });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup
        side="bottom"
        showCloseButton={false}
        className="personal-app max-h-[90dvh] gap-0 rounded-t-[var(--personal-radius-xl)] border-[var(--personal-border)] bg-[var(--personal-surface)] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex justify-center pt-2 pb-1">
          <span
            aria-hidden="true"
            className="h-1 w-9 rounded-full bg-[var(--personal-border-strong)]"
          />
        </div>
        <div className="relative flex h-[52px] items-center px-2">
          <SheetTitle className="pointer-events-none absolute inset-x-16 text-center text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
            New chat
          </SheetTitle>
          <span className="flex-1" />
          <SheetClose
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-full text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <X aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
          </SheetClose>
        </div>
        <div className="px-4 pt-1 pb-2">
          <div className="relative flex h-11 items-center">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3.5 size-[18px] text-[var(--personal-text-secondary)]"
              strokeWidth={1.75}
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search bots"
              aria-label="Search bots"
              className="h-11 w-full rounded-full border-0 bg-[var(--personal-fill-muted)] pr-4 pl-10 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            />
          </div>
        </div>
        {error !== null ? (
          <p role="alert" className="px-4 pb-2 text-[14px] text-[var(--personal-error)]">
            {error}
          </p>
        ) : null}
        <ul aria-label="Bots" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {shown.map((summary, index) => (
            <li key={summary.bot.botId}>
              <button
                type="button"
                onClick={() => void pick(summary.bot.botId)}
                disabled={busyBotId !== null}
                aria-busy={busyBotId === summary.bot.botId}
                aria-label={`New chat with ${summary.bot.name}`}
                className={cn(
                  "relative flex h-16 w-full items-center gap-3 px-4 text-left outline-none",
                  "personal-press focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)] personal-row-hover",
                  index > 0 &&
                    "before:absolute before:inset-x-0 before:top-0 before:left-[68px] before:h-[var(--personal-hairline)] before:bg-[var(--personal-border)]",
                )}
              >
                <BotAvatar
                  shape={summary.bot.avatarShape}
                  color={summary.bot.avatarColor}
                  size={40}
                  label={summary.bot.name}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
                    {summary.bot.name}
                  </span>
                  <span className="truncate text-[13px] leading-4 text-[var(--personal-text-secondary)]">
                    {summary.bot.title.trim().length > 0
                      ? summary.bot.title
                      : (summary.modelLabel ?? "")}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {shown.length === 0 ? (
            <li className="px-4 py-6 text-center text-[15px] text-[var(--personal-text-secondary)]">
              No bots match "{query.trim()}".
            </li>
          ) : null}
        </ul>
        <div className="flex items-center gap-2 border-t border-[var(--personal-border)] px-4 py-3">
          <button
            type="button"
            onClick={() => void go("/bots/groups/new")}
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[var(--personal-radius-control)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <Plus aria-hidden="true" className="size-4" strokeWidth={2} />
            New group
          </button>
          <button
            type="button"
            onClick={() => void go("/bots/new")}
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[var(--personal-radius-control)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <Plus aria-hidden="true" className="size-4" strokeWidth={2} />
            New bot
          </button>
        </div>
        <span className="sr-only">{`${shown.length} bots`}</span>
      </SheetPopup>
    </Sheet>
  );
}
