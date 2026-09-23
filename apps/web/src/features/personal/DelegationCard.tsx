import type { JSX } from "react";
import { memo, useMemo, useState } from "react";

import type { EnvironmentId, PersonalBot, PersonalTask } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Ellipsis, X } from "lucide-react";

import { workEntryDisplayLabel } from "~/components/chat/MessagesTimeline.logic";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { deriveWorkLogEntries, type WorkLogEntry } from "~/session-logic";
import { useThreadDetail } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { commandFailureMessage } from "./commandFeedback";
import { type DelegationStep, type DelegationTone, deriveDelegationCard } from "./delegationModel";
import { personalTaskCancel } from "./usePersonalAutomation";

const NO_ACTIVITIES: ReadonlyArray<never> = [];

const TONE_DOT: Record<DelegationTone, string> = {
  neutral: "bg-[var(--personal-text-tertiary)]",
  live: "bg-[var(--personal-live)]",
  review: "bg-[var(--personal-review)]",
  done: "bg-[var(--personal-live)]",
  error: "bg-[var(--personal-error)]",
};

const STEP_STATE_TEXT: Record<DelegationStep["state"], string> = {
  done: "done",
  current: "in progress",
  failed: "failed",
};

function StepIcon({ state }: { state: DelegationStep["state"] }) {
  if (state === "current") {
    return (
      <span
        aria-hidden="true"
        className="size-[18px] shrink-0 rounded-full border-2 border-[var(--personal-text)] bg-[var(--personal-fill-muted)]"
      />
    );
  }
  const Icon = state === "done" ? Check : X;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded-full",
        state === "done" ? "bg-[var(--personal-live)]" : "bg-[var(--personal-error)]",
      )}
    >
      <Icon className="size-3 text-white" strokeWidth={3} />
    </span>
  );
}

/**
 * ui-spec Screen 2 delegation card: the child bot, the task it was handed and
 * its real progress. Everything comes from the child task (via the
 * `personalTasks.subscribe` feed) and, while it runs, its thread's work log.
 */
export const DelegationCard = memo(function DelegationCard({
  environmentId,
  task,
  bot,
  providerLabel,
  waitingFor,
}: {
  environmentId: EnvironmentId;
  task: PersonalTask;
  bot: PersonalBot | null;
  providerLabel: string | null;
  /** When the child is itself parked on a bot: "Waiting for Researcher". */
  waitingFor: string | null;
}): JSX.Element {
  const navigate = useNavigate();
  const cancel = useAtomCommand(personalTaskCancel);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Steps only show while the child runs, so only then is its thread read.
  const childRef = useMemo(
    () =>
      task.status === "running" && task.threadId !== null
        ? { environmentId, threadId: task.threadId }
        : null,
    [environmentId, task.status, task.threadId],
  );
  const childThread = useThreadDetail(childRef);
  const activities = childThread?.activities ?? NO_ACTIVITIES;
  const entries = useMemo(() => deriveWorkLogEntries(activities), [activities]);
  const card = deriveDelegationCard({
    task,
    entries,
    labelOf: (entry: WorkLogEntry) => workEntryDisplayLabel(entry, undefined),
    waitingFor,
  });

  const name = bot?.name ?? "Deleted bot";
  const threadId = task.threadId;
  const onCancel = async () => {
    setCancelling(true);
    const result = await cancel({ environmentId, input: { taskId: task.taskId } });
    setCancelling(false);
    setActionError(commandFailureMessage(result, "Could not cancel."));
  };

  return (
    <section
      aria-label={`${name}: ${task.title}`}
      className={cn(
        "relative max-w-[90%] rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-3.5",
        // Nothing to open yet (the child has no thread): the card stays flat,
        // so it never invites a tap that would do nothing.
        threadId !== null && "active:bg-[var(--personal-fill-muted)]",
      )}
    >
      {threadId === null ? null : (
        // Stretched link: the whole card opens the child's chat, while the
        // controls below sit on top of it as positioned siblings, so a tap on
        // Interrupt or the menu never falls through to the card.
        <Link
          to="/bots/$botId/$threadId"
          params={{ botId: task.botId, threadId }}
          aria-label={`Open ${name}'s chat for this task`}
          className="absolute inset-0 rounded-[var(--personal-radius-card)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        />
      )}
      <div className="relative flex min-w-0 items-center gap-3">
        {bot !== null ? (
          <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={34} label={bot.name} />
        ) : (
          <span
            aria-hidden="true"
            className="size-[34px] shrink-0 rounded-full bg-[var(--personal-fill-muted)]"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
            {name}
          </p>
          {providerLabel !== null ? (
            <p className="truncate text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
              {providerLabel}
            </p>
          ) : null}
        </div>
        {card.canCancel ? (
          // Stopping a running bot is the one thing worth reaching for in a
          // hurry, so it is a button on the card, not a menu item.
          <button
            type="button"
            disabled={cancelling}
            aria-busy={cancelling}
            onClick={() => void onCancel()}
            className="flex h-9 shrink-0 items-center rounded-full border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 text-[13px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40"
          >
            {task.status === "running" ? "Interrupt" : "Cancel"}
          </button>
        ) : null}
        {threadId !== null ? (
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Options for ${name}'s task`}
                  className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
                />
              }
            >
              <Ellipsis aria-hidden="true" className="size-5" strokeWidth={1.75} />
            </MenuTrigger>
            <MenuPopup align="end" className="personal-app personal-menu min-w-44">
              <MenuItem
                onClick={() =>
                  void navigate({
                    to: "/bots/$botId/$threadId",
                    params: { botId: task.botId, threadId },
                  })
                }
              >
                Open chat
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>

      <p className="mt-3 text-sm font-medium break-words text-[var(--personal-text)]">
        {task.title}
      </p>

      <p className="mt-2 flex min-w-0 items-center gap-2 text-[13px] text-[var(--personal-text-secondary)]">
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", TONE_DOT[card.tone])}
        />
        <span className="min-w-0 truncate">{card.status}</span>
      </p>

      {card.steps.length > 0 ? (
        <ol aria-label="Recent steps" className="mt-2 flex flex-col gap-2">
          {card.steps.map((step) => (
            <li key={step.id} className="flex min-w-0 items-center gap-2 text-sm">
              <StepIcon state={step.state} />
              <span className="min-w-0 truncate text-[var(--personal-text)]/80">{step.label}</span>
              <span className="sr-only">, {STEP_STATE_TEXT[step.state]}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {card.detail !== null ? (
        <p className="mt-2 line-clamp-4 text-sm leading-[1.45] break-words whitespace-pre-wrap text-[var(--personal-text-secondary)]">
          {card.detail}
        </p>
      ) : null}

      {actionError !== null ? (
        <p role="alert" className="mt-2 text-[13px] text-[var(--personal-danger)]">
          {actionError}
        </p>
      ) : null}
    </section>
  );
});
