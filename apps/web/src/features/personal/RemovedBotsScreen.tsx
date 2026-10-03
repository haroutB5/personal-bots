import type { JSX } from "react";
import { useMemo, useState } from "react";

import type { PersonalBotId, PersonalRemovedBot } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Check, ChevronLeft } from "lucide-react";

import { BotAvatar } from "./BotAvatar";

import {
  chatsKeptLabel,
  mergeSeenRemovedBots,
  removedBotSubtitle,
  removedByLine,
  restoredMessage,
} from "./removedBotsModel";
import { useMinuteNow } from "./useMinuteNow";
import { usePersonalEnvironmentId } from "./usePersonalBots";
import { useRemovedBots, useRestoreRemovedBot } from "./useRemovedBots";

function RemovedBotRow({
  bot,
  nowMs,
  restoredNote,
  onRestore,
}: {
  bot: PersonalRemovedBot;
  nowMs: number;
  restoredNote: string | undefined;
  onRestore: (bot: PersonalRemovedBot) => Promise<string | null>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = await onRestore(bot);
    setBusy(false);
    setError(failure);
  };

  if (restoredNote !== undefined) {
    return (
      <li className="flex items-start gap-3 px-4 py-3.5">
        <Check
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-[var(--personal-text)]"
          strokeWidth={2}
        />
        <p
          role="status"
          className="min-w-0 flex-1 text-[15px] font-semibold break-words text-[var(--personal-text)]"
        >
          {restoredNote}
        </p>
      </li>
    );
  }

  return (
    <li className="flex items-start gap-3 px-4 py-3.5">
      <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={40} label={bot.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[15px] font-semibold break-words text-[var(--personal-text)]">
          {bot.name}
        </span>
        <span className="text-[13px] break-words text-[var(--personal-text-secondary)]">
          {removedBotSubtitle(bot)}
        </span>
        <span className="text-[13px] break-words text-[var(--personal-text-secondary)]">
          {removedByLine(bot, nowMs)}
        </span>
        {bot.reason !== null && bot.reason.trim().length > 0 ? (
          <span className="line-clamp-2 text-[13px] break-words text-[var(--personal-text-secondary)]">
            Reason: {bot.reason}
          </span>
        ) : null}
        <span className="text-[13px] text-[var(--personal-text-secondary)]">
          {chatsKeptLabel(bot.chats)}
        </span>
        {error !== null ? (
          <p role="alert" className="text-sm break-words text-[var(--personal-error)]">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void restore()}
          disabled={busy}
          aria-busy={busy}
          aria-label={busy ? `Restoring ${bot.name}` : `Restore ${bot.name}`}
          className="mt-2 h-11 self-start rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-5 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-surface)] disabled:opacity-40"
        >
          {busy ? "Restoring…" : "Restore"}
        </button>
      </div>
    </li>
  );
}

/**
 * /bots/settings/removed: bots a team lead removed, and Restore. Only the owner
 * reaches this; a lead has no way to bring a bot back.
 */
export function RemovedBotsScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const list = useRemovedBots(environmentId);
  const restoreBot = useRestoreRemovedBot(environmentId);
  const nowMs = useMinuteNow();
  const [seen, setSeen] = useState<ReadonlyArray<PersonalRemovedBot>>([]);
  const [seenFrom, setSeenFrom] = useState<typeof list.data>(null);
  const [restored, setRestored] = useState<Readonly<Record<string, string>>>({});

  // A restored bot leaves the server's list on the refresh its own command
  // triggers, so rows render from everything seen, not from the list alone.
  if (list.data !== seenFrom) {
    setSeenFrom(list.data);
    if (list.data !== null) setSeen((previous) => mergeSeenRemovedBots(previous, list.data!.bots));
  }

  const rows = useMemo(() => {
    const current = new Map((list.data?.bots ?? []).map((bot) => [bot.botId as string, bot]));
    return seen.flatMap((bot) => {
      const id: string = bot.botId;
      const note = restored[id];
      if (note !== undefined) return [{ bot, note }];
      const latest = current.get(id);
      return latest === undefined ? [] : [{ bot: latest, note: undefined as string | undefined }];
    });
  }, [seen, list.data, restored]);

  const onRestore = async (bot: PersonalRemovedBot): Promise<string | null> => {
    const outcome = await restoreBot(bot.botId as PersonalBotId);
    if (outcome.status === "failed") return outcome.message;
    setRestored((previous) => ({
      ...previous,
      [bot.botId]: restoredMessage(outcome.result),
    }));
    return null;
  };

  return (
    <div className="flex flex-col px-5 pb-8">
      <header className="flex h-14 items-center gap-1">
        <Link
          to="/bots/settings"
          activeOptions={{ exact: true }}
          aria-label="Back to Settings"
          className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        <h1 className="min-w-0 flex-1 text-[19px] font-bold text-[var(--personal-text)]">
          Removed bots
        </h1>
      </header>

      <p className="text-[14px] leading-snug text-[var(--personal-text-secondary)]">
        Bots a team lead removed. Their chats, memory and settings are kept; restoring one puts it
        back on its team.
      </p>

      {list.error !== null ? (
        <p role="alert" className="mt-3 text-sm text-[var(--personal-error)]">
          {list.error}
        </p>
      ) : null}

      {list.data === null && seen.length === 0 ? (
        list.error === null ? (
          <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">Loading…</p>
        ) : null
      ) : rows.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-2 text-center">
          <p className="text-lg font-semibold text-[var(--personal-text)]">No removed bots</p>
          <p className="max-w-[300px] text-[15px] leading-snug text-[var(--personal-text-secondary)]">
            When a team lead removes one of its bots, it shows up here.
          </p>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--personal-border)] overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]">
          {rows.map(({ bot, note }) => (
            <RemovedBotRow
              key={bot.botId}
              bot={bot}
              nowMs={nowMs}
              restoredNote={note}
              onRestore={onRestore}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
