import type { CSSProperties, JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  botTeam,
  isBotOnTeam,
  isTeamLead,
  sameTeam,
  type EnvironmentId,
  type PersonalBot,
  type PersonalBotTeam,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";

import { BotAvatar } from "./BotAvatar";
import { PersonalPageHeader } from "./BotForm";
import { isThreadLive } from "./botSummaries";
import { commandFailureMessage } from "./commandFeedback";
import { friendlyTurnError } from "./conversationModel";
import { useLaptopOffline } from "./PersonalOfflineBanner";
import {
  buildTeamConnectors,
  buildTeamDropZones,
  buildTeamGroups,
  buildTeamGroupsLayout,
  countTeamMembers,
  crossTeamDelegationPath,
  delegationConnectorPath,
  deriveDelegationLinks,
  laneDelegationPath,
  teamConnectorLanes,
  teamDiagramSummary,
  teamDropHint,
  teamDropOutcome,
  type TeamDropZone,
} from "./teamDiagramModel";
import { usePersonalTasks } from "./usePersonalAutomation";
import {
  personalBotUpdate,
  personalProfileSet,
  usePersonalBotsList,
  usePersonalEnvironmentId,
  usePersonalProfile,
} from "./usePersonalBots";
import { useTeamBotDrag } from "./useTeamBotDrag";

const NODE_SIZE = 64;
/** Leads are drawn a size up, so each team reads as one head and its members. */
const LEAD_SIZE = 76;
/** The `w-24` name column under every node; the connector lanes stay clear of it. */
const LABEL_WIDTH = 96;
const DEFAULT_WIDTH = 320;

const LAYOUT_OPTIONS = {
  leadSize: LEAD_SIZE,
  nodeSize: NODE_SIZE,
  gapX: 32,
  gapY: 88,
  bandGap: 56,
  headingSpace: 28,
  perRow: 4,
};

function nodeStyle(x: number, y: number, size: number): CSSProperties {
  return { left: x, top: y - size / 2, transform: "translateX(-50%)" };
}

function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "Y";
}

/** An optimistic team move, held until the refreshed list already says the same. */
interface PendingMove {
  readonly botId: string;
  readonly team: PersonalBotTeam;
  readonly lead: boolean;
}

interface MoveFeedback {
  readonly tone: "info" | "error";
  readonly text: string;
}

function TeamDiagram({
  bots,
  ownerName,
  tasks,
  liveBotIds,
  environmentId,
  customTeams,
}: {
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly ownerName: string;
  readonly tasks: Parameters<typeof deriveDelegationLinks>[0];
  readonly liveBotIds: ReadonlySet<string>;
  readonly environmentId: EnvironmentId | null;
  readonly customTeams: ReadonlyArray<PersonalBotTeam>;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [feedback, setFeedback] = useState<MoveFeedback | null>(null);
  const [liveHint, setLiveHint] = useState("");
  const updateBot = useAtomCommand(personalBotUpdate);
  const offline = useLaptopOffline();

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

  // The optimistic move is done the moment the refreshed list says the same
  // thing, so the overlay is dropped rather than left to fight the server.
  if (pending !== null) {
    const settled = bots.find((bot) => bot.botId === pending.botId);
    if (
      settled !== undefined &&
      sameTeam(botTeam(settled), pending.team) &&
      isTeamLead(settled) === pending.lead
    ) {
      setPending(null);
    }
  }

  // The node jumps to its new place the moment the finger lets go, and stays
  // there until the server agrees. A failed move clears `pending`, so the node
  // snaps back to where it came from.
  const shown = useMemo(() => {
    if (pending === null) return bots;
    return bots.map((bot) => {
      if (bot.botId === pending.botId) return { ...bot, team: pending.team, lead: pending.lead };
      // One lead per team, optimistically too: never two badges for a blink.
      if (pending.lead && isBotOnTeam(bot, pending.team)) return { ...bot, lead: false };
      return bot;
    });
  }, [bots, pending]);

  const groups = useMemo(() => buildTeamGroups(shown, customTeams), [shown, customTeams]);
  const layout = useMemo(
    () => buildTeamGroupsLayout(groups, { ...LAYOUT_OPTIONS, width }),
    [groups, width],
  );
  const botIdSet = useMemo(() => new Set(shown.map((bot) => bot.botId as string)), [shown]);
  const teamById = useMemo(
    () =>
      new Map<string, PersonalBotTeam>(
        shown.map((bot) => [bot.botId as string, botTeam(bot)] as const),
      ),
    [shown],
  );
  const leadIds = useMemo(
    () => new Set(groups.flatMap((group) => (group.leadBotId === null ? [] : [group.leadBotId]))),
    [groups],
  );
  const [openedAt] = useState(Date.now);
  const delegationLinks = useMemo(
    () => deriveDelegationLinks(tasks, botIdSet, openedAt),
    [botIdSet, openedAt, tasks],
  );
  const summary = useMemo(
    () => teamDiagramSummary(ownerName, groups, shown, delegationLinks),
    [shown, delegationLinks, groups, ownerName],
  );
  const connectors = useMemo(
    () =>
      buildTeamConnectors(groups, layout, {
        width,
        leadSize: LEAD_SIZE,
        nodeSize: NODE_SIZE,
        labelWidth: LABEL_WIDTH,
      }),
    [groups, layout, width],
  );
  const lanes = useMemo(
    () =>
      teamConnectorLanes(layout, {
        width,
        leadSize: LEAD_SIZE,
        nodeSize: NODE_SIZE,
        labelWidth: LABEL_WIDTH,
      }),
    [layout, width],
  );
  const dropZones = useMemo(
    () => buildTeamDropZones(layout, { width, leadSize: LEAD_SIZE, nodeSize: NODE_SIZE }),
    [layout, width],
  );

  const dropBots = useMemo(
    () =>
      shown.map((bot) => ({
        botId: bot.botId as string,
        name: bot.name,
        team: botTeam(bot),
        lead: isTeamLead(bot),
      })),
    [shown],
  );
  const dropBot = useCallback(
    (botId: string) => dropBots.find((bot) => bot.botId === botId) ?? null,
    [dropBots],
  );

  const onDrop = useCallback(
    (botId: string, zone: TeamDropZone | null) => {
      const bot = dropBot(botId);
      if (bot === null) return;
      if (zone === null) {
        setLiveHint(`${bot.name} stayed where it was.`);
        return;
      }
      const outcome = teamDropOutcome(bot, zone.target, dropBots);
      if (outcome.kind === "none") {
        setLiveHint(outcome.message);
        return;
      }
      if (outcome.kind === "blocked") {
        setFeedback({ tone: "error", text: outcome.message });
        return;
      }
      if (environmentId === null || offline) {
        setFeedback({
          tone: "error",
          text: `Your computer is offline, so ${bot.name} can't be moved yet. Try again once it reconnects.`,
        });
        return;
      }
      setFeedback(null);
      setPending({ botId, ...outcome.update });
      void (async () => {
        const result = await updateBot({
          environmentId,
          input: { botId: bot.botId as PersonalBot["botId"], ...outcome.update },
        });
        if (result._tag === "Success") {
          setFeedback({ tone: "info", text: outcome.message });
          return;
        }
        setPending(null);
        const fallback = `${bot.name} couldn't be moved. Try again.`;
        setFeedback({
          tone: "error",
          text: friendlyTurnError(commandFailureMessage(result, fallback) ?? fallback, fallback)
            .message,
        });
      })();
    },
    [dropBot, dropBots, environmentId, offline, updateBot],
  );

  const { drag, handlersFor } = useTeamBotDrag({
    containerRef,
    zones: dropZones,
    onLift: useCallback(
      (botId: string) => {
        const bot = dropBot(botId);
        setFeedback(null);
        setLiveHint(
          bot === null ? "" : `${bot.name} lifted. Drag it onto a team, or onto a lead slot.`,
        );
      },
      [dropBot],
    ),
    onHover: useCallback(
      (botId: string, zone: TeamDropZone | null) => {
        const bot = dropBot(botId);
        if (bot !== null) setLiveHint(teamDropHint(bot, zone, dropBots));
      },
      [dropBot, dropBots],
    ),
    onDrop,
    onCancel: useCallback(
      (botId: string) => {
        const bot = dropBot(botId);
        setLiveHint(bot === null ? "" : `${bot.name} stayed where it was.`);
      },
      [dropBot],
    ),
  });

  const dragged = drag === null ? null : dropBot(drag.botId);
  /**
   * While a bot is in the air: every landing that would change something, with
   * the one refusal spelled out rather than dressed up as a valid target. The
   * chief nodes are left out — the node itself lights up instead.
   */
  const activeZones =
    dragged === null
      ? []
      : dropZones.flatMap((zone) => {
          if (!zone.id.startsWith("band:") && !zone.id.startsWith("lead:")) return [];
          const outcome = teamDropOutcome(dragged, zone.target, dropBots);
          if (outcome.kind === "none") return [];
          return [
            {
              zone,
              blocked: outcome.kind === "blocked",
              label: outcome.kind === "blocked" ? "Needs a new lead first" : zone.label,
            },
          ];
        });

  return (
    <>
      <p className="mt-2 text-[15px] leading-5 text-[var(--personal-text-secondary)]">
        Press and hold a bot to move it to the other team, or onto a lead slot to put it in charge.
        You can also change this from the bot&apos;s own page.
      </p>
      <span aria-live="polite" role="status" className="sr-only">
        {liveHint}
      </span>
      {feedback === null ? null : (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`mt-3 rounded-[var(--personal-radius-card)] border px-4 py-2.5 text-[15px] leading-snug ${
            feedback.tone === "error"
              ? "border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] text-[var(--personal-text)]"
              : "border-[var(--personal-border)] bg-[var(--personal-surface)] text-[var(--personal-text)]"
          }`}
        >
          {feedback.text}
        </div>
      )}
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
            <marker
              id="team-cross-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--personal-review)" />
            </marker>
          </defs>

          {/*
          You to each team's lead down the outer lane, and each lead to its own
          members down that team's lane. Elbows, never straight centre lines:
          a line that ran from the owner through the dev band to the
          assistant's lead made the two teams read as one chain.
        */}
          {connectors.map((connector) => (
            <path
              key={connector.key}
              d={connector.d}
              fill="none"
              stroke="var(--personal-team-line)"
              strokeWidth="1.5"
              strokeLinecap="round"
              markerEnd={connector.arrow ? "url(#team-owner-arrow)" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {delegationLinks.map((link) => {
            const from = layout.bots.get(link.from);
            const to = layout.bots.get(link.to);
            if (from === undefined || to === undefined) return null;
            const running = link.state === "running";
            // A handoff across teams only exists because the owner allowed it,
            // so it is drawn apart rather than hidden.
            const fromTeam = teamById.get(link.from);
            const toTeam = teamById.get(link.to);
            // Case-insensitively, so two rows spelled differently but drawn in
            // the one band do not get the across-teams colour and lane.
            const crossTeam =
              fromTeam === undefined || toTeam === undefined
                ? fromTeam !== toTeam
                : !sameTeam(fromTeam, toTeam);
            // Side by side in one row, the bow is the clearest line there is.
            // Between rows it would sag across the row below and through
            // whichever node shares that column, so it takes a lane instead.
            const sameRow = !crossTeam && from.row === to.row;
            const stroke = crossTeam
              ? "var(--personal-review)"
              : running
                ? "var(--personal-team-live)"
                : "var(--personal-team-recent)";
            return (
              <path
                key={`${link.from}:${link.to}`}
                d={
                  crossTeam
                    ? crossTeamDelegationPath(from, to, { lane: lanes.cross, nodeSize: NODE_SIZE })
                    : sameRow
                      ? delegationConnectorPath(from, to, NODE_SIZE)
                      : laneDelegationPath(from, to, {
                          lane: lanes.delegation,
                          fromSize: leadIds.has(link.from) ? LEAD_SIZE : NODE_SIZE,
                          toSize: leadIds.has(link.to) ? LEAD_SIZE : NODE_SIZE,
                        })
                }
                fill="none"
                stroke={stroke}
                strokeWidth={running ? 2.5 : 1.5}
                strokeDasharray={crossTeam ? "2 6" : running ? "8 5" : "4 7"}
                strokeLinecap="round"
                markerEnd={
                  crossTeam
                    ? "url(#team-cross-arrow)"
                    : running
                      ? "url(#team-live-arrow)"
                      : "url(#team-recent-arrow)"
                }
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        <div
          className="absolute z-10 flex w-24 flex-col items-center bg-[var(--personal-bg)] text-center"
          style={nodeStyle(layout.owner.x, layout.owner.y, LEAD_SIZE)}
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

        {activeZones.map(({ zone, blocked, label }) => {
          const active = drag?.zone?.id === zone.id;
          const isLeadSlot = zone.target.kind === "lead";
          const tone = blocked
            ? "border-[var(--personal-review-border)] bg-[var(--personal-review-bg)]"
            : active
              ? "border-[var(--personal-primary)] bg-[color-mix(in_srgb,var(--personal-primary)_14%,transparent)]"
              : "border-[var(--personal-border)] bg-[color-mix(in_srgb,var(--personal-text)_4%,transparent)]";
          return (
            <div
              key={zone.id}
              aria-hidden="true"
              className={`pointer-events-none absolute z-20 flex rounded-[var(--personal-radius-card)] border-2 border-dashed ${
                isLeadSlot ? "items-center justify-center" : "items-start justify-end p-2"
              } ${tone}`}
              style={{
                left: zone.rect.x,
                top: zone.rect.y,
                width: zone.rect.width,
                height: zone.rect.height,
              }}
            >
              <span
                className={`rounded-full px-2 py-0.5 text-center text-[11px] leading-4 font-semibold ${
                  active && !blocked
                    ? "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
                    : "bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)]"
                }`}
              >
                {label}
              </span>
            </div>
          );
        })}

        {layout.bands.map((band) => (
          <div
            key={`heading:${band.team}`}
            aria-hidden="true"
            className="absolute inset-x-0 z-0 flex items-center gap-2"
            style={{ top: band.labelY }}
          >
            <span className="min-w-0 truncate text-xs font-semibold tracking-wide text-[var(--personal-section-label)] uppercase">
              {band.label}
            </span>
            <span className="h-px flex-1 bg-[var(--personal-border)]" />
          </div>
        ))}

        {shown.map((bot) => {
          const position = layout.bots.get(bot.botId);
          if (position === undefined) return null;
          const live = liveBotIds.has(bot.botId);
          const isLead = leadIds.has(bot.botId);
          const size = isLead ? LEAD_SIZE : NODE_SIZE;
          const lifted = drag?.botId === bot.botId;
          // A chief node is itself a drop target: landing on it joins its team.
          const overChief = drag !== null && drag.zone?.id === `chief:${botTeam(bot)}` && isLead;
          const label = [
            bot.name,
            isLead ? "team lead" : "",
            bot.title.trim(),
            live ? "working" : "",
          ]
            .filter(Boolean)
            .join(", ");
          return (
            <div
              key={bot.botId}
              {...handlersFor(bot.botId)}
              className={`absolute flex w-24 flex-col items-center text-center ${
                lifted ? "z-40" : "z-10"
              }`}
              style={{
                ...nodeStyle(position.x, position.y, size),
                // pan-y keeps a flick scrolling the page; the long press that
                // lifts a node blocks touchmove itself once it matures.
                touchAction: "pan-y pinch-zoom",
                WebkitTouchCallout: "none",
                transform: lifted
                  ? `translateX(-50%) translate(${String(drag.delta.x)}px, ${String(drag.delta.y)}px) scale(1.06)`
                  : "translateX(-50%)",
                transition: drag === null ? "transform 180ms ease" : "none",
                filter: lifted ? "drop-shadow(var(--personal-shadow-lift))" : undefined,
                opacity: drag !== null && !lifted ? 0.65 : 1,
              }}
            >
              <Link
                to="/bots/$botId"
                params={{ botId: bot.botId }}
                aria-label={label}
                draggable={false}
                className={`relative flex shrink-0 rounded-full outline-none active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)] ${
                  overChief
                    ? "ring-4 ring-[var(--personal-primary)] ring-offset-2 ring-offset-[var(--personal-bg)]"
                    : isLead
                      ? "ring-2 ring-[var(--personal-primary)] ring-offset-2 ring-offset-[var(--personal-bg)]"
                      : ""
                }`}
                style={{ width: size, height: size }}
              >
                <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} label="" />
              </Link>
              {/*
              Only the text carries the page background. When the whole column
              did, it tiled with its neighbours and hid every line drawn at or
              below the avatars.
            */}
              <div className="flex w-24 flex-col items-center bg-[var(--personal-bg)]">
                {isLead ? (
                  <span
                    aria-hidden="true"
                    className="mt-1 rounded-full bg-[var(--personal-primary)] px-1.5 text-[10px] leading-4 font-semibold text-[var(--personal-primary-text)]"
                  >
                    Lead
                  </span>
                ) : null}
                <Link
                  to="/bots/$botId/edit"
                  params={{ botId: bot.botId }}
                  aria-label={`Edit ${bot.name}`}
                  draggable={false}
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
            </div>
          );
        })}
      </div>
    </>
  );
}

function TeamManager({
  environmentId,
  teams,
  bots,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly teams: ReadonlyArray<string>;
  readonly bots: ReadonlyArray<PersonalBot>;
}): JSX.Element {
  const saveProfile = useAtomCommand(personalProfileSet);
  const offline = useLaptopOffline();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || offline || environmentId === null;
  const changeTeam = async (operation: "create" | "delete", teamName: string) => {
    if (disabled || environmentId === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveProfile({
        environmentId,
        input: { teamChange: { operation, name: teamName.trim() } },
      });
      if (result._tag === "Success") {
        setName("");
        setOpen(false);
      } else {
        setError(commandFailureMessage(result, "Couldn't save the team. Try again."));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Manage teams" className="my-4 space-y-3">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className="min-h-11 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] disabled:opacity-50"
      >
        {open ? "Cancel" : "New team"}
      </button>
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void changeTeam("create", name);
          }}
          className="space-y-2"
        >
          <label
            htmlFor="new-team-name"
            className="block text-sm font-medium text-[var(--personal-text)]"
          >
            Team name
          </label>
          <input
            id="new-team-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            required
            disabled={busy}
            placeholder="e.g. Research"
            className="h-11 w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3 text-base text-[var(--personal-text)]"
          />
          <button
            type="submit"
            disabled={disabled || name.trim().length === 0}
            className="min-h-11 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] disabled:opacity-50"
          >
            {busy ? "Saving…" : "Create team"}
          </button>
        </form>
      ) : null}
      {teams.length > 0 ? (
        <ul className="divide-y divide-[var(--personal-border)]">
          {teams.map((team) => {
            const count = countTeamMembers(bots, team);
            return (
              <li
                key={team}
                className="flex min-h-11 items-center justify-between gap-3 text-sm text-[var(--personal-text)]"
              >
                <span className="min-w-0 break-words">
                  {team} · {count} {count === 1 ? "bot" : "bots"}
                </span>
                {count === 0 ? (
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Remove ${team}`}
                    onClick={() => void changeTeam("delete", team)}
                    className="min-h-11 shrink-0 px-2 text-[var(--personal-text-secondary)]"
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-sm text-[var(--personal-text)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** /bots/team: teams behind their leads, and current or recent handoffs. */
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
      <TeamManager
        environmentId={profile.data === null ? null : environmentId}
        teams={profile.data?.customTeams ?? []}
        bots={bots}
      />
      {profile.error !== null ? (
        <p role="alert" className="text-sm text-[var(--personal-text)]">
          Couldn't load your teams.{" "}
          <button type="button" onClick={profile.refresh} className="min-h-11 px-2 underline">
            Try again
          </button>
        </p>
      ) : null}

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

      {bots.length > 0 || (profile.data?.customTeams?.length ?? 0) > 0 ? (
        <>
          <p className="mt-2 text-[15px] leading-5 text-[var(--personal-text-secondary)]">
            Each team can have a lead. Move bots by long-pressing and dragging them onto a team, or
            choose a team in the bot's settings.
          </p>
          <TeamDiagram
            bots={bots}
            ownerName={ownerName}
            tasks={tasks}
            liveBotIds={liveBotIds}
            environmentId={environmentId}
            customTeams={profile.data?.customTeams ?? []}
          />
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
            <span className="flex items-center gap-2">
              <svg aria-hidden="true" width="24" height="4" viewBox="0 0 24 4">
                <path d="M0 2H24" stroke="var(--personal-review)" strokeDasharray="2 6" />
              </svg>
              Across teams, you asked
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}
