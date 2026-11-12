import { useState, type CSSProperties, type JSX } from "react";

import { isThreadLive } from "@hbots/personal-client/bots/botSummaries";
import { currentProgressNote } from "@hbots/personal-client/bots/workingProgress";
import {
  barGeometry,
  buildWorkTimeline,
  timelineTicks,
  workTickLabel,
  WORK_RANGES,
  workBarsById,
  workBarTimeLabel,
  workChatTurns,
  workElapsedLabel,
  workInitiatorLabel,
  workRangeMs,
  type WorkBar,
  type WorkGroup,
  type WorkRangeId,
  type WorkTimeline,
  type WorkTone,
} from "@hbots/personal-client/work/workTimeline";
import type { PersonalBot, PersonalTask, PersonalTaskId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { commandFailureMessage } from "./commandFeedback";
import { canCancelTask, mergeTaskLists, stopTaskConfirmMessage } from "./taskPresentation";
import { useBotShells } from "./useBotShells";
import { useMinuteNow } from "./useMinuteNow";
import {
  personalTaskCancel,
  usePersonalRelatedTasks,
  usePersonalTasks,
} from "./usePersonalAutomation";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";
import { useWorkingProgressNotes } from "./useWorkingProgress";

/** Share of the track where the now line sits; queued work is drawn after it. */
const NOW_AT = 0.88;
const TICK_COUNT = 4;

const STRIPES =
  "repeating-linear-gradient(135deg, var(--personal-live) 0 3px, transparent 3px 7px)";

/** The fill of the part of a bar after its plain work: the wait, or the whole bar. */
function toneFill(tone: WorkTone): CSSProperties {
  switch (tone) {
    case "working":
      return { background: "var(--personal-live)" };
    case "waitingOthers":
      return { backgroundImage: STRIPES, opacity: 0.75 };
    case "needsYou":
      return { background: "var(--personal-review)" };
    case "failed":
      return { background: "var(--personal-error)" };
    case "done":
    case "stopped":
      return { background: "var(--personal-text-tertiary)", opacity: 0.45 };
    case "queued":
      return { border: "1px dashed var(--personal-text-tertiary)" };
  }
}

const TONE_TEXT: Record<WorkTone, string> = {
  working: "text-[var(--personal-live)]",
  waitingOthers: "text-[var(--personal-text-secondary)]",
  needsYou: "text-[var(--personal-review-text)]",
  failed: "text-[var(--personal-error)]",
  done: "text-[var(--personal-text-tertiary)]",
  stopped: "text-[var(--personal-text-tertiary)]",
  queued: "text-[var(--personal-text-secondary)]",
};

const clock = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Bar({
  bar,
  timeline,
  selected,
  onSelect,
}: {
  readonly bar: WorkBar;
  readonly timeline: WorkTimeline;
  readonly selected: boolean;
  readonly onSelect: (barId: string) => void;
}): JSX.Element {
  const geometry = barGeometry(bar, timeline, NOW_AT);
  // Work before a wait is plain green; a bar that never waited has one part.
  const split =
    (bar.tone === "waitingOthers" || bar.tone === "needsYou") && geometry.workedShare > 0;
  return (
    <button
      type="button"
      data-testid={`work-bar-${bar.id}`}
      data-tone={bar.tone}
      aria-label={`${bar.title}, ${workBarTimeLabel(bar, timeline.nowMs)}`}
      aria-pressed={selected}
      onClick={() => onSelect(bar.id)}
      className={`absolute top-1 flex h-4 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-inset ${
        geometry.clippedStart ? "rounded-r-sm" : "rounded-sm"
      } ${selected ? "ring-2 ring-[var(--personal-text)]" : ""}`}
      style={{
        left: `${geometry.left * 100}%`,
        width: `${geometry.width * 100}%`,
        minWidth: 6,
      }}
    >
      {split ? (
        <span
          aria-hidden="true"
          className="h-full shrink-0 bg-[var(--personal-live)]"
          style={{ width: `${geometry.workedShare * 100}%` }}
        />
      ) : null}
      <span aria-hidden="true" className="h-full min-w-0 flex-1" style={toneFill(bar.tone)} />
    </button>
  );
}

function Track({
  bars,
  timeline,
  selectedId,
  onSelect,
}: {
  readonly bars: ReadonlyArray<WorkBar>;
  readonly timeline: WorkTimeline;
  readonly selectedId: string | null;
  readonly onSelect: (barId: string) => void;
}): JSX.Element {
  return (
    <div className="relative h-6 rounded-md bg-[var(--personal-fill-muted)]">
      <span
        aria-hidden="true"
        className="absolute inset-y-0 w-px bg-[var(--personal-text-secondary)]"
        style={{ left: `${NOW_AT * 100}%` }}
      />
      {bars.map((bar) => (
        <Bar
          key={bar.id}
          bar={bar}
          timeline={timeline}
          selected={bar.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function Group({
  group,
  timeline,
  botById,
  selectedId,
  onSelect,
}: {
  readonly group: WorkGroup;
  readonly timeline: WorkTimeline;
  readonly botById: ReadonlyMap<string, PersonalBot>;
  readonly selectedId: string | null;
  readonly onSelect: (barId: string) => void;
}): JSX.Element {
  return (
    <section
      data-testid={`work-group-${group.key}`}
      className="rounded-[var(--personal-radius-card,14px)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 py-2.5"
    >
      <h2 className="truncate text-[12px] font-medium text-[var(--personal-text-secondary)]">
        {workInitiatorLabel(group.initiator)}
      </h2>
      <ul className="mt-1.5 flex flex-col gap-2">
        {group.lanes.map((lane) => {
          const bot = botById.get(lane.botId);
          const latest = lane.bars.at(-1);
          return (
            <li
              key={`${lane.botId}:${lane.depth}`}
              style={{ paddingLeft: Math.min(lane.depth, 3) * 14 }}
              className={
                lane.depth > 0 ? "border-l border-[var(--personal-border)] ml-2.5" : undefined
              }
            >
              <button
                type="button"
                onClick={() => (latest === undefined ? undefined : onSelect(latest.id))}
                className="flex min-h-9 w-full min-w-0 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-inset"
              >
                {bot === undefined ? (
                  <span
                    aria-hidden="true"
                    className="size-5 shrink-0 rounded-full bg-[var(--personal-fill-muted)]"
                  />
                ) : (
                  <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={20} label="" />
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--personal-text)]">
                  <span className="font-semibold">{bot?.name ?? "Removed bot"}</span>
                  {latest === undefined ? null : (
                    <span className="text-[var(--personal-text-secondary)]"> · {latest.title}</span>
                  )}
                </span>
                {latest === undefined ? null : (
                  <span
                    className={`shrink-0 text-[11px] font-medium tabular-nums ${TONE_TEXT[latest.tone]}`}
                  >
                    {workBarTimeLabel(latest, timeline.nowMs)}
                  </span>
                )}
              </button>
              <Track
                bars={lane.bars}
                timeline={timeline}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface WorkDetail {
  readonly bar: WorkBar;
  readonly initiator: string;
  /** The bot's own latest progress line, when its chat is working. Never made up. */
  readonly step: string | undefined;
  readonly canStop: boolean;
}

function DetailSheet({
  detail,
  bot,
  nowMs,
  busy,
  error,
  onClose,
  onStop,
}: {
  readonly detail: WorkDetail;
  readonly bot: PersonalBot | undefined;
  readonly nowMs: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onStop: () => void;
}): JSX.Element {
  const { bar } = detail;
  const rows: Array<readonly [string, string]> = [
    ["Status", workBarTimeLabel(bar, nowMs)],
    ["Started", bar.tone === "queued" ? "Not yet" : clock(bar.startMs)],
    [
      bar.endMs === null ? "Running for" : "Took",
      bar.tone === "queued" ? "Not started" : workElapsedLabel((bar.endMs ?? nowMs) - bar.startMs),
    ],
  ];
  if (bar.endMs !== null) rows.push(["Ended", clock(bar.endMs)]);
  const action =
    "flex h-11 flex-1 items-center justify-center rounded-[var(--personal-radius-button)] px-3 text-[14px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-inset";
  return (
    <aside
      data-testid="work-detail"
      aria-label="Work detail"
      className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-[var(--personal-border)] bg-[var(--personal-surface)] px-4 pt-3 pb-4 shadow-[var(--personal-shadow-card)]"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-[var(--personal-text)]">
            {bar.title}
          </p>
          <p className="truncate text-[12px] text-[var(--personal-text-secondary)]">
            {bot?.name ?? "Removed bot"} · {detail.initiator}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close detail"
          onClick={onClose}
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-inset"
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[var(--personal-text-secondary)]">{label}</dt>
            <dd className={`tabular-nums ${label === "Status" ? TONE_TEXT[bar.tone] : ""}`}>
              {value}
            </dd>
          </div>
        ))}
        {detail.step === undefined ? null : (
          <div className="contents">
            <dt className="text-[var(--personal-text-secondary)]">Now</dt>
            <dd className="line-clamp-2">{detail.step}</dd>
          </div>
        )}
      </dl>
      {error === null ? null : (
        <p role="alert" className="mt-2 text-[13px] text-[var(--personal-error)]">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        {bar.threadId === null ? null : (
          <Link
            to="/bots/$botId/$threadId"
            params={{ botId: bar.botId, threadId: bar.threadId }}
            className={`${action} bg-[var(--personal-primary)] text-[var(--personal-primary-text)]`}
          >
            {bar.tone === "needsYou" ? "Answer" : "Open chat"}
          </Link>
        )}
        {bar.taskId === null ? null : (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: bar.taskId }}
            className={`${action} bg-[var(--personal-fill-muted)] text-[var(--personal-text)]`}
          >
            Full log
          </Link>
        )}
        {detail.canStop ? (
          <button
            type="button"
            disabled={busy}
            onClick={onStop}
            className={`${action} bg-[var(--personal-fill-muted)] text-[var(--personal-danger)] disabled:opacity-50`}
          >
            Stop
          </button>
        ) : null}
      </div>
    </aside>
  );
}

export interface WorkTimelineViewProps {
  readonly timeline: WorkTimeline;
  readonly range: WorkRangeId;
  readonly onRange: (range: WorkRangeId) => void;
  readonly botById: ReadonlyMap<string, PersonalBot>;
  readonly detail: WorkDetail | null;
  readonly onSelect: (barId: string | null) => void;
  readonly onStop: () => void;
  readonly busy: boolean;
  readonly error: string | null;
}

/** The Work tab without its data hooks: everything it shows comes in as props. */
export function WorkTimelineView(props: WorkTimelineViewProps): JSX.Element {
  const { timeline, botById, detail } = props;
  const selectedId = detail?.bar.id ?? null;
  const ticks = timelineTicks(timeline, TICK_COUNT);
  const idleNames = timeline.idleBotIds.flatMap((botId) => botById.get(botId)?.name ?? []);
  return (
    <>
      <nav
        aria-label="Time range"
        className="mt-3 grid h-11 grid-cols-3 rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)]"
      >
        {WORK_RANGES.map((entry) => {
          const active = entry.id === props.range;
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={active}
              onClick={() => props.onRange(entry.id)}
              className="flex h-11 min-w-0 rounded-[var(--personal-radius-button)] p-0.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-inset"
            >
              <span
                className={`flex flex-1 items-center justify-center rounded-lg ${
                  active
                    ? "bg-[var(--personal-surface)] font-semibold text-[var(--personal-text)] shadow-[var(--personal-shadow-card)]"
                    : "text-[var(--personal-text-secondary)]"
                }`}
              >
                {entry.label}
              </span>
            </button>
          );
        })}
      </nav>

      {timeline.needs.length === 0 ? null : (
        <section
          data-testid="work-needs"
          aria-label="Waiting for you"
          className="mt-3 rounded-[var(--personal-radius-card,14px)] border border-[var(--personal-review)] bg-[var(--personal-review-bg,transparent)] px-3 py-2"
        >
          <h2 className="text-[13px] font-semibold text-[var(--personal-review-text)]">
            {timeline.needs.length === 1
              ? "1 bot is waiting for you"
              : `${timeline.needs.length} bots are waiting for you`}
          </h2>
          <ul>
            {timeline.needs.map((bar) => (
              <li key={bar.id}>
                <button
                  type="button"
                  onClick={() => props.onSelect(bar.id)}
                  className="flex min-h-11 w-full min-w-0 items-center gap-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-inset"
                >
                  <span className="min-w-0 flex-1 truncate text-[var(--personal-text)]">
                    <span className="font-semibold">
                      {botById.get(bar.botId)?.name ?? "Removed bot"}
                    </span>{" "}
                    · {bar.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--personal-review-text)] tabular-nums">
                    {workElapsedLabel(timeline.nowMs - (bar.waitSinceMs ?? bar.startMs))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div
        aria-hidden="true"
        className="relative mt-4 h-4 px-3 text-[10px] text-[var(--personal-text-tertiary)] tabular-nums"
      >
        <div className="relative h-full">
          {ticks.map((tick, index) => (
            <span
              key={tick}
              className="absolute top-0 whitespace-nowrap"
              style={{
                left: `${(index / TICK_COUNT) * NOW_AT * 100}%`,
                transform: index === 0 ? undefined : "translateX(-50%)",
              }}
            >
              {index === TICK_COUNT ? "now" : workTickLabel(tick)}
            </span>
          ))}
        </div>
      </div>

      {timeline.groups.length === 0 ? (
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">
          No bot has worked in this time range.
        </p>
      ) : (
        <div className="mt-1 flex flex-col gap-2">
          {timeline.groups.map((group) => (
            <Group
              key={group.key}
              group={group}
              timeline={timeline}
              botById={botById}
              selectedId={selectedId}
              onSelect={props.onSelect}
            />
          ))}
        </div>
      )}

      {idleNames.length === 0 ? null : (
        <p
          data-testid="work-idle"
          className="mt-3 text-[12px] text-[var(--personal-text-tertiary)]"
        >
          Idle: {idleNames.join(", ")}
        </p>
      )}

      {detail === null ? null : (
        <DetailSheet
          detail={detail}
          bot={botById.get(detail.bar.botId)}
          nowMs={timeline.nowMs}
          busy={props.busy}
          error={props.error}
          onClose={() => props.onSelect(null)}
          onStop={props.onStop}
        />
      )}
    </>
  );
}

const NO_TASKS: ReadonlyArray<PersonalTask> = [];

/**
 * /work: who is working, for how long, on what, and who started it. One group
 * per request, a lane per bot, a bar per piece of work, all from the task feed
 * and the chat shells. It shows only times and steps the server recorded.
 */
export function WorkScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const { tasks: feed, error } = usePersonalTasks(environmentId);
  const botsQuery = usePersonalBotsList(environmentId);
  const shells = useBotShells(environmentId);
  const now = useMinuteNow();
  const [range, setRange] = useState<WorkRangeId>("4h");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const cancel = useAtomCommand(personalTaskCancel);

  // A helper's task can outlive its request in the feed: ask for the roots the
  // feed lacks, so "who started it" is read, never guessed.
  const missing = new Set<string>();
  for (const task of feed?.values() ?? []) {
    if (!feed?.has(task.rootTaskId)) missing.add(task.rootTaskId);
  }
  const missingRootIds = [...missing].toSorted().slice(0, 100) as PersonalTaskId[];
  const roots = usePersonalRelatedTasks(
    environmentId,
    missingRootIds.length === 0 ? null : { taskIds: missingRootIds },
  );
  const tasks = mergeTaskLists(feed, roots);

  const bots = botsQuery.data?.bots;
  const links = botsQuery.data?.threads;
  const botById = new Map<string, PersonalBot>((bots ?? []).map((bot) => [bot.botId, bot]));
  const botIdByThread = new Map<string, string>(
    (links ?? []).map((link) => [link.threadId, link.botId]),
  );
  const timeline = buildWorkTimeline({
    tasks: tasks === null ? NO_TASKS : [...tasks.values()],
    chats: workChatTurns(shells, botIdByThread),
    botIds: (bots ?? []).map((bot) => bot.botId),
    nowMs: now,
    rangeMs: workRangeMs(range, now),
    chatTitles: new Map(shells.map((shell) => [shell.id as string, shell.title])),
  });

  const liveShells = shells.filter(isThreadLive);
  const notes = useWorkingProgressNotes(
    environmentId,
    liveShells.map((shell) => ({ threadId: shell.id as string, updatedAt: shell.updatedAt })),
  );

  const bar = selectedId === null ? undefined : workBarsById(timeline).get(selectedId);
  const group =
    bar === undefined
      ? undefined
      : timeline.groups.find((entry) =>
          entry.lanes.some((lane) => lane.bars.some((candidate) => candidate.id === bar.id)),
        );
  const task = bar?.taskId == null ? undefined : tasks?.get(bar.taskId);
  const shell =
    bar?.threadId == null ? undefined : liveShells.find((entry) => entry.id === bar.threadId);
  const detail: WorkDetail | null =
    bar === undefined
      ? null
      : {
          bar,
          initiator: group === undefined ? "" : workInitiatorLabel(group.initiator),
          step: shell === undefined ? undefined : currentProgressNote(notes.get(shell.id), shell),
          canStop: task !== undefined && canCancelTask(task.status),
        };

  const stop = async () => {
    if (task === undefined || environmentId === null) return;
    const message = stopTaskConfirmMessage(task.title);
    const confirmed =
      (await requestConfirmDialog(message, {
        variant: "destructive",
        confirmLabel: "Stop task",
      })) ?? window.confirm(message);
    if (!confirmed) return;
    setBusy(true);
    setActionError(null);
    const result = await cancel({ environmentId, input: { taskId: task.taskId } });
    setBusy(false);
    setActionError(commandFailureMessage(result, "Could not stop the task."));
  };

  return (
    <div className="mx-auto w-full max-w-[1024px] px-4 pt-4">
      <header className="flex min-h-11 items-center">
        <h1 className="text-[28px] leading-8 font-bold text-[var(--personal-text)]">Work</h1>
      </header>
      {error !== null ? (
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">{error}</p>
      ) : tasks === null ? (
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">Loading…</p>
      ) : (
        <WorkTimelineView
          timeline={timeline}
          range={range}
          onRange={setRange}
          botById={botById}
          detail={detail}
          onSelect={(barId) => {
            setActionError(null);
            setSelectedId(barId);
          }}
          onStop={() => void stop()}
          busy={busy}
          error={actionError}
        />
      )}
    </div>
  );
}
