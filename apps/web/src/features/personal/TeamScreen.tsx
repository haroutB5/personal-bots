import type { CSSProperties, JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { PersonalBot } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { useThreadShells } from "~/state/entities";

import { BotAvatar } from "./BotAvatar";
import { PersonalPageHeader } from "./BotForm";
import { isThreadLive } from "./botSummaries";
import {
  buildTeamLayout,
  delegationConnectorPath,
  deriveDelegationLinks,
  teamDiagramSummary,
} from "./teamDiagramModel";
import { usePersonalTasks } from "./usePersonalAutomation";
import {
  usePersonalBotsList,
  usePersonalEnvironmentId,
  usePersonalProfile,
} from "./usePersonalBots";

const NODE_SIZE = 64;
const DEFAULT_WIDTH = 320;

function nodeStyle(x: number, y: number): CSSProperties {
  return { left: x, top: y - NODE_SIZE / 2, transform: "translateX(-50%)" };
}

function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "Y";
}

function TeamDiagram({
  bots,
  ownerName,
  tasks,
  liveBotIds,
}: {
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly ownerName: string;
  readonly tasks: Parameters<typeof deriveDelegationLinks>[0];
  readonly liveBotIds: ReadonlySet<string>;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const botIds = useMemo(() => bots.map((bot) => bot.botId as string), [bots]);
  const layout = useMemo(
    () =>
      buildTeamLayout(botIds, {
        width,
        nodeSize: NODE_SIZE,
        gapX: 32,
        gapY: 80,
        perRow: 4,
      }),
    [botIds, width],
  );
  const botIdSet = useMemo(() => new Set(botIds), [botIds]);
  const [openedAt] = useState(Date.now);
  const delegationLinks = useMemo(
    () => deriveDelegationLinks(tasks, botIdSet, openedAt),
    [botIdSet, openedAt, tasks],
  );
  const summary = useMemo(
    () => teamDiagramSummary(ownerName, bots, delegationLinks),
    [bots, delegationLinks, ownerName],
  );

  return (
    <div ref={containerRef} className="relative mt-6 w-full" style={{ height: layout.svgHeight }}>
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${width} ${layout.svgHeight}`}
        width={width}
        height={layout.svgHeight}
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
      >
        <defs>
          <marker
            id="team-owner-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--personal-team-line)" />
          </marker>
          <marker
            id="team-live-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--personal-team-live)" />
          </marker>
          <marker
            id="team-recent-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--personal-team-recent)" />
          </marker>
        </defs>

        {bots.map((bot) => {
          const position = layout.bots.get(bot.botId);
          if (position === undefined) return null;
          return (
            <line
              key={`owner:${bot.botId}`}
              x1={layout.owner.x}
              y1={layout.owner.y + NODE_SIZE / 2 + 4}
              x2={position.x}
              y2={position.y - NODE_SIZE / 2 - 10}
              stroke="var(--personal-team-line)"
              strokeWidth="1.5"
              markerEnd="url(#team-owner-arrow)"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {delegationLinks.map((link) => {
          const from = layout.bots.get(link.from);
          const to = layout.bots.get(link.to);
          if (from === undefined || to === undefined) return null;
          const running = link.state === "running";
          return (
            <path
              key={`${link.from}:${link.to}`}
              d={delegationConnectorPath(from, to, NODE_SIZE)}
              fill="none"
              stroke={running ? "var(--personal-team-live)" : "var(--personal-team-recent)"}
              strokeWidth={running ? 2.5 : 1.5}
              strokeDasharray={running ? "8 5" : "4 7"}
              strokeLinecap="round"
              markerEnd={running ? "url(#team-live-arrow)" : "url(#team-recent-arrow)"}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>

      <div
        className="absolute z-10 flex w-24 flex-col items-center bg-[var(--personal-bg)] text-center"
        style={nodeStyle(layout.owner.x, layout.owner.y)}
      >
        <span className="flex size-16 items-center justify-center rounded-full bg-[var(--personal-primary)] text-2xl font-bold text-[var(--personal-primary-text)] ring-4 ring-[var(--personal-bg)]">
          {initialOf(ownerName)}
        </span>
        <span className="mt-2 max-w-24 truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
          {ownerName}
        </span>
        {ownerName === "You" ? null : (
          <span className="text-xs leading-4 text-[var(--personal-text-secondary)]">You</span>
        )}
      </div>

      {bots.map((bot) => {
        const position = layout.bots.get(bot.botId);
        if (position === undefined) return null;
        const live = liveBotIds.has(bot.botId);
        const label = [bot.name, bot.title.trim(), live ? "working" : ""]
          .filter(Boolean)
          .join(", ");
        return (
          <div
            key={bot.botId}
            className="absolute z-10 flex w-24 flex-col items-center bg-[var(--personal-bg)] text-center"
            style={nodeStyle(position.x, position.y)}
          >
            <Link
              to="/bots/$botId"
              params={{ botId: bot.botId }}
              aria-label={label}
              className="flex size-16 shrink-0 rounded-full outline-none active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]"
            >
              <BotAvatar
                shape={bot.avatarShape}
                color={bot.avatarColor}
                size={NODE_SIZE}
                label=""
              />
            </Link>
            <Link
              to="/bots/$botId/edit"
              params={{ botId: bot.botId }}
              aria-label={`Edit ${bot.name}`}
              className="flex min-h-11 max-w-24 items-center gap-1.5 rounded-[var(--personal-radius-button)] outline-none active:opacity-70 focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            >
              {live ? (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full bg-[var(--personal-team-live)]"
                />
              ) : null}
              <span className="truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
                {bot.name}
              </span>
            </Link>
            {bot.title.trim().length > 0 ? (
              <span className="-mt-3 max-w-24 truncate text-xs leading-4 text-[var(--personal-text-secondary)]">
                {bot.title}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** /bots/team: owner-to-bot structure and current or recent bot delegations. */
export function TeamScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const list = usePersonalBotsList(environmentId);
  const profile = usePersonalProfile(environmentId);
  const { tasks: taskFeed } = usePersonalTasks(environmentId);
  const allShells = useThreadShells();
  const bots = useMemo(
    () => (list.data?.bots ?? []).toSorted((left, right) => left.sortOrder - right.sortOrder),
    [list.data],
  );
  const tasks = useMemo(() => (taskFeed === null ? [] : [...taskFeed.values()]), [taskFeed]);
  const liveBotIds = useMemo(() => {
    if (list.data === null) return new Set<string>();
    const liveThreadIds = new Set(
      allShells
        .filter(
          (shell) =>
            shell.environmentId === environmentId &&
            shell.archivedAt === null &&
            isThreadLive(shell),
        )
        .map((shell) => shell.id as string),
    );
    return new Set(
      list.data.threads
        .filter((thread) => thread.archivedAt === null && liveThreadIds.has(thread.threadId))
        .map((thread) => thread.botId as string),
    );
  }, [allShells, environmentId, list.data]);
  const ownerName = profile.data?.displayName.trim() || "You";

  return (
    <div className="flex min-h-full flex-col px-5 pb-8">
      <PersonalPageHeader title="Team" />

      {environmentId === null ? (
        <p className="mt-4 text-[15px] text-[var(--personal-text-secondary)]">
          Connect to your computer to see your team.
        </p>
      ) : null}

      {list.error !== null ? (
        <div className="mt-6 flex items-center justify-between gap-3 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4">
          <p className="min-w-0 text-[15px] text-[var(--personal-text)]">
            Couldn&apos;t load your bots. {list.error}
          </p>
          <button
            type="button"
            onClick={list.refresh}
            className="h-11 shrink-0 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-4 text-[15px] font-medium text-[var(--personal-text)]"
          >
            Try again
          </button>
        </div>
      ) : null}

      {list.data === null && list.error === null && environmentId !== null ? (
        <p role="status" className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">
          Loading your team…
        </p>
      ) : null}

      {list.data !== null && bots.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-3 text-center">
          <p className="text-lg font-semibold text-[var(--personal-text)]">No bots yet</p>
          <p className="max-w-[280px] text-[15px] leading-snug text-[var(--personal-text-secondary)]">
            Give a bot a name, a look and a provider, then see how your team works together.
          </p>
          <Link
            to="/bots/new"
            className="mt-2 flex h-11 items-center rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-5 text-[15px] font-semibold text-[var(--personal-primary-text)]"
          >
            Create your first bot
          </Link>
        </div>
      ) : null}

      {bots.length > 0 ? (
        <>
          <p className="mt-2 text-[15px] leading-5 text-[var(--personal-text-secondary)]">
            Active and recent handoffs between your bots.
          </p>
          <TeamDiagram bots={bots} ownerName={ownerName} tasks={tasks} liveBotIds={liveBotIds} />
          <div
            aria-label="Diagram key"
            className="mt-2 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-[var(--personal-text-secondary)]"
          >
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="h-px w-6 bg-[var(--personal-team-line)]" />
              Your bots
            </span>
            <span className="flex items-center gap-2">
              <svg aria-hidden="true" width="24" height="4" viewBox="0 0 24 4">
                <path
                  d="M0 2H24"
                  stroke="var(--personal-team-live)"
                  strokeWidth="2"
                  strokeDasharray="6 4"
                />
              </svg>
              Active handoff
            </span>
            <span className="flex items-center gap-2">
              <svg aria-hidden="true" width="24" height="4" viewBox="0 0 24 4">
                <path d="M0 2H24" stroke="var(--personal-team-recent)" strokeDasharray="4 5" />
              </svg>
              Recent handoff
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}
