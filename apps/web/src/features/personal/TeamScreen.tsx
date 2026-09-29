import type { JSX } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import {
  botTeam,
  isTeamLead,
  sameTeam,
  type EnvironmentId,
  type PersonalBot,
  type PersonalBotTeam,
} from "@t3tools/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { Sheet, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { useThreadShells } from "~/state/entities";
import { primaryServerProvidersAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { PersonalPageHeader } from "./BotForm";
import { TEAM_VIEW_STATE_KEY } from "./botsBackStack";
import { isThreadLive } from "./botSummaries";
import { botModelShortLabel } from "./botModelLabel";
import { commandFailureMessage } from "./commandFeedback";
import { friendlyTurnError } from "./conversationModel";
import { shownInTeamChart } from "./groupModel";
import { NewTeamForm } from "./NewTeamForm";
import { useLaptopOffline } from "./PersonalOfflineBanner";
import {
  TeamConstellationCard,
  type ConstellationBot,
  type ConstellationSpoke,
} from "./TeamConstellationCard";
import { TeamLeadConfirm } from "./TeamLeadConfirm";
import { TeamMembersSheet, type MemberListRow } from "./TeamMembersSheet";
import { TeamMoveOverlay } from "./TeamMoveOverlay";
import { TeamMoveToast } from "./TeamMoveToast";
import { TeamWorkingNow } from "./TeamWorkingNow";
import {
  applyTeamUpdate,
  deriveDelegationCounts,
  deriveWorkingNow,
  leadConfirmCopy,
  planDrop,
  teamMoveTargets,
  undoMessage,
  undoPlan,
  type LeadReplacement,
  type UndoStep,
} from "./teamConstellationModel";
import {
  buildTeamGroups,
  NEW_TEAM_ZONE_ID,
  teamDropHint,
  teamDropOutcome,
  teamDropZoneId,
  type TeamDropOutcome,
  type TeamDropTarget,
} from "./teamDiagramModel";
import { takeTeamNotice, type TeamNotice } from "./teamNotice";
import { parseTeamView, registerTeamViewSource, type TeamView } from "./teamView";
import { usePersonalTasks } from "./usePersonalAutomation";
import {
  personalBotUpdate,
  personalProfileSet,
  usePersonalBotsList,
  usePersonalEnvironmentId,
  usePersonalProfile,
} from "./usePersonalBots";
import { useMinuteNow } from "./useMinuteNow";
import { useTeamHandoffTasks } from "./useTeamHandoffTasks";
import { useTeamBotDrag } from "./useTeamBotDrag";

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

interface ToastState {
  readonly text: string;
  readonly undo: (() => void) | null;
}

interface ConfirmState {
  readonly botId: string;
  readonly target: TeamDropTarget;
  readonly replaced: LeadReplacement;
}

const NO_BOTS: ReadonlyArray<PersonalBot> = [];

/** The element the Team screen scrolls in: `main`, or the clipped column behind a chat mid-swipe. */
function teamScroller(from: Element | null): HTMLElement | null {
  for (let node = from?.parentElement ?? null; node !== null; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden") return node;
  }
  return null;
}

/** How far the screen is scrolled: the top card and how far past its top edge, plus the raw offset. */
function readTeamScroll(container: HTMLElement | null): Omit<TeamView, "membersTeam"> {
  const scroller = teamScroller(container);
  if (container === null || scroller === null) {
    return { scrollTop: 0, anchorTeam: null, anchorOffset: 0 };
  }
  const top = scroller.getBoundingClientRect().top;
  for (const card of container.querySelectorAll<HTMLElement>("[data-team]")) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom > top + 8) {
      return {
        scrollTop: scroller.scrollTop,
        anchorTeam: card.getAttribute("data-team"),
        anchorOffset: Math.round(top - rect.top),
      };
    }
  }
  return { scrollTop: scroller.scrollTop, anchorTeam: null, anchorOffset: 0 };
}

/** Puts the screen back where {@link readTeamScroll} found it. False when it has nowhere to scroll yet. */
function applyTeamScroll(container: HTMLElement | null, view: TeamView): boolean {
  const scroller = teamScroller(container);
  if (container === null || scroller === null) return false;
  if (view.anchorTeam !== null) {
    const card = container.querySelector<HTMLElement>(
      `[data-team="${CSS.escape(view.anchorTeam)}"]`,
    );
    if (card !== null) {
      const delta =
        card.getBoundingClientRect().top - scroller.getBoundingClientRect().top + view.anchorOffset;
      scroller.scrollTop += delta;
      return true;
    }
  }
  scroller.scrollTop = view.scrollTop;
  return true;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Direction B, "Constellation": every team is a card with its lead at the
 * centre and its members around it, spokes for the lead's handoffs, and a
 * zoomed-out set of drop cards while a bot is being moved.
 */
function TeamBoard({
  bots,
  allBots,
  ownerName,
  tasks,
  liveBotIds,
  environmentId,
  customTeams,
  focusTeam,
  onCreated,
  initialView,
}: {
  readonly bots: ReadonlyArray<PersonalBot>;
  /** Every bot, group-only ones too: the New team form checks names against all of them. */
  readonly allBots: ReadonlyArray<PersonalBot>;
  readonly ownerName: string;
  readonly tasks: Parameters<typeof deriveDelegationCounts>[0];
  readonly liveBotIds: ReadonlySet<string>;
  readonly environmentId: EnvironmentId | null;
  readonly customTeams: ReadonlyArray<PersonalBotTeam>;
  /** A team just made: its card is brought into view once it is drawn. */
  readonly focusTeam: string | null;
  readonly onCreated: (notice: TeamNotice) => void;
  /** Coming back from a page opened here: how the screen was left. */
  readonly initialView: TeamView | null;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const focusedTeam = useRef<string | null>(null);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const nowMs = useMinuteNow();
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [feedback, setFeedback] = useState<MoveFeedback | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [liveHint, setLiveHint] = useState("");
  const [hint, setHint] = useState("");
  const [tapBotId, setTapBotId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [membersTeam, setMembersTeam] = useState<string | null>(initialView?.membersTeam ?? null);
  const [newTeamBotId, setNewTeamBotId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const updateBot = useAtomCommand(personalBotUpdate);
  const saveProfile = useAtomCommand(personalProfileSet);
  const offline = useLaptopOffline();

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

  // The bot jumps to its new card the moment the finger lets go, and stays
  // there until the server agrees. A failed move clears `pending`, so it snaps
  // back to where it came from.
  const shown = useMemo(() => {
    // One lead per team, optimistically too: never two badges for a blink.
    return pending === null ? bots : applyTeamUpdate(bots, pending);
  }, [bots, pending]);

  const groups = useMemo(() => buildTeamGroups(shown, customTeams), [shown, customTeams]);
  const botById = useMemo(
    () => new Map<string, PersonalBot>(shown.map((bot) => [bot.botId as string, bot] as const)),
    [shown],
  );
  const botIdSet = useMemo(() => new Set(botById.keys()), [botById]);
  const counts = useMemo(
    () => deriveDelegationCounts(tasks, botIdSet, nowMs),
    [botIdSet, nowMs, tasks],
  );
  const working = useMemo(() => deriveWorkingNow(tasks, botIdSet), [botIdSet, tasks]);
  const openHandoffsBy = useCallback(
    (botId: string) => working.filter((item) => item.from === botId).length,
    [working],
  );
  const workingFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of working) {
      const from = botById.get(item.from);
      if (from !== undefined && !map.has(item.to)) map.set(item.to, from.name);
    }
    return map;
  }, [botById, working]);
  const modelLabels = useMemo(
    () =>
      new Map(
        shown.map((bot) => [
          bot.botId as string,
          botModelShortLabel(bot.modelSelection, providers),
        ]),
      ),
    [providers, shown],
  );
  const entryOf = useCallback(
    (bot: PersonalBot): ConstellationBot => ({
      bot,
      modelLabel: modelLabels.get(bot.botId) ?? null,
      live: liveBotIds.has(bot.botId),
      workingFor: workingFor.get(bot.botId) ?? null,
    }),
    [liveBotIds, modelLabels, workingFor],
  );
  const maxSpoke = useMemo(
    () => counts.reduce((max, entry) => Math.max(max, entry.recent), 0),
    [counts],
  );

  const scrollToTeam = useCallback((team: string) => {
    const card = containerRef.current?.querySelector(`[data-team="${CSS.escape(team)}"]`);
    card?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  // The new team sits after the older ones, often below the fold on a phone:
  // scroll to its card once the refreshed list has drawn it, once per team.
  useEffect(() => {
    if (focusTeam === null || focusedTeam.current === focusTeam) return;
    if (!groups.some((group) => sameTeam(group.team, focusTeam))) return;
    focusedTeam.current = focusTeam;
    const group = groups.find((candidate) => sameTeam(candidate.team, focusTeam));
    if (group !== undefined) scrollToTeam(group.team);
  }, [focusTeam, groups, scrollToTeam]);

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

  // What the screen looks like is handed to the history when a bot, a chat, an
  // edit form or a task is opened from it (botsBackStack.ts), and put back here
  // when Back returns: the scroll position, and the members list if it was open.
  const membersTeamRef = useRef(membersTeam);
  membersTeamRef.current = membersTeam;
  useEffect(
    () =>
      registerTeamViewSource(() => ({
        ...readTeamScroll(containerRef.current),
        membersTeam: membersTeamRef.current,
      })),
    [],
  );
  useLayoutEffect(() => {
    if (initialView === null) return;
    const container = containerRef.current;
    applyTeamScroll(container, initialView);
    // The Working now card and the cards' own measuring settle just after the
    // first paint and move things: apply again until the owner takes the scroll.
    const scroller = teamScroller(container);
    let stopped = false;
    const settle = () => {
      if (!stopped) applyTeamScroll(container, initialView);
    };
    const frames = [0, 0].map(() => 0);
    frames[0] = window.requestAnimationFrame(() => {
      settle();
      frames[1] = window.requestAnimationFrame(settle);
    });
    const timer = window.setTimeout(settle, 500);
    const stop = () => {
      stopped = true;
    };
    scroller?.addEventListener("touchstart", stop, { passive: true, once: true });
    scroller?.addEventListener("wheel", stop, { passive: true, once: true });
    return () => {
      stopped = true;
      for (const frame of frames) window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      scroller?.removeEventListener("touchstart", stop);
      scroller?.removeEventListener("wheel", stop);
    };
    // Once, when the screen first draws its cards.
  }, []);

  const failMessage = (result: Parameters<typeof commandFailureMessage>[0], fallback: string) =>
    friendlyTurnError(commandFailureMessage(result, fallback) ?? fallback, fallback).message;

  const focusBot = useCallback((botId: string) => {
    window.requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector<HTMLElement>(`[data-bot-node="${CSS.escape(botId)}"]`)
        ?.focus();
    });
  }, []);

  const runUndo = useCallback(
    async (steps: ReadonlyArray<UndoStep>, botName: string) => {
      const last = steps.at(-1);
      if (environmentId === null || last === undefined) return;
      setToast(null);
      setFeedback(null);
      setPending({ botId: last.botId, team: last.team, lead: last.lead });
      for (const step of steps) {
        const result = await updateBot({
          environmentId,
          input: { botId: step.botId as PersonalBot["botId"], team: step.team, lead: step.lead },
        });
        if (result._tag !== "Success") {
          setPending(null);
          setFeedback({
            tone: "error",
            text: failMessage(result, `${botName} couldn't be moved back. Try again.`),
          });
          return;
        }
      }
      const message = undoMessage(botName, last.team, last.lead);
      setLiveHint(message);
      setToast({ text: message, undo: null });
      scrollToTeam(last.team);
    },
    [environmentId, scrollToTeam, updateBot],
  );

  const commitMove = useCallback(
    async (
      bot: {
        readonly botId: string;
        readonly name: string;
        readonly team?: PersonalBotTeam;
        readonly lead?: boolean;
      },
      outcome: Extract<TeamDropOutcome, { kind: "update" }>,
      replaced: LeadReplacement | null,
    ) => {
      if (environmentId === null) return;
      const before = { botId: bot.botId, team: botTeam(bot), lead: isTeamLead(bot) };
      setFeedback(null);
      setToast(null);
      setPending({ botId: bot.botId, ...outcome.update });
      requestAnimationFrame(() => scrollToTeam(outcome.update.team));
      const result = await updateBot({
        environmentId,
        input: { botId: bot.botId as PersonalBot["botId"], ...outcome.update },
      });
      if (result._tag === "Success") {
        setLiveHint(outcome.message);
        const steps = undoPlan({ before, replaced, destination: outcome.update.team });
        setToast({ text: outcome.message, undo: () => void runUndo(steps, bot.name) });
        return;
      }
      setPending(null);
      setFeedback({
        tone: "error",
        text: failMessage(result, `${bot.name} couldn't be moved. Try again.`),
      });
    },
    [environmentId, runUndo, scrollToTeam, updateBot],
  );

  /** A drop (or a tap on a card) means `target` for `botId`; a Lead drop over a lead asks first. */
  const applyMove = useCallback(
    (botId: string, target: TeamDropTarget, confirmed: boolean) => {
      const bot = dropBot(botId);
      if (bot === null) return;
      setTapBotId(null);
      const plan = planDrop({ bot, target, roster: dropBots, openHandoffsBy, confirmed });
      if (plan.kind === "none") {
        setLiveHint(plan.message);
        return;
      }
      if (plan.kind === "blocked") {
        setFeedback({ tone: "error", text: plan.message });
        setLiveHint(plan.message);
        return;
      }
      if (environmentId === null || offline) {
        setFeedback({
          tone: "error",
          text: `Your computer is offline, so ${bot.name} can't be moved yet. Try again once it reconnects.`,
        });
        return;
      }
      if (plan.kind === "confirm") {
        setLiveHint(`Make ${bot.name} the lead? ${plan.replaced.oldLeadName} stops leading.`);
        setConfirm({ botId, target, replaced: plan.replaced });
        return;
      }
      void commitMove(bot, plan.outcome, plan.replaced);
    },
    [commitMove, dropBot, dropBots, environmentId, offline, openHandoffsBy],
  );

  const zoneTargets = useMemo(() => {
    const map = new Map<string, TeamDropTarget>();
    for (const group of groups) {
      for (const kind of ["team", "lead"] as const) {
        const target = { kind, team: group.team };
        map.set(teamDropZoneId(target), target);
      }
    }
    return map;
  }, [groups]);

  const zoneAt = useCallback((x: number, y: number): string | null => {
    if (typeof document.elementsFromPoint !== "function") return null;
    for (const element of document.elementsFromPoint(x, y)) {
      const zone = element.closest("[data-team-move-overlay] [data-drop-zone]");
      if (zone !== null) return zone.getAttribute("data-drop-zone");
    }
    return null;
  }, []);

  const hintFor = useCallback(
    (botId: string, zoneId: string | null): string => {
      const bot = dropBot(botId);
      if (bot === null) return "";
      if (zoneId === NEW_TEAM_ZONE_ID) return `Let go to start a new team with ${bot.name}.`;
      const target = zoneId === null ? undefined : zoneTargets.get(zoneId);
      return teamDropHint(
        bot,
        target === undefined || zoneId === null ? null : { id: zoneId, target },
        dropBots,
      );
    },
    [dropBot, dropBots, zoneTargets],
  );

  const dropOn = useCallback(
    (botId: string, zoneId: string | null) => {
      const bot = dropBot(botId);
      if (bot === null) return;
      if (zoneId === null) {
        // Let go over nothing: the cards stay up to tap, or cancel.
        setTapBotId(botId);
        setHint(`Tap a team or a lead seat to move ${bot.name}, or cancel.`);
        setLiveHint(`${bot.name} is waiting. Tap a team or a lead seat, or cancel.`);
        return;
      }
      if (zoneId === NEW_TEAM_ZONE_ID) {
        setTapBotId(null);
        setNewTeamBotId(botId);
        return;
      }
      const target = zoneTargets.get(zoneId);
      if (target !== undefined) applyMove(botId, target, false);
    },
    [applyMove, dropBot, zoneTargets],
  );

  const { drag, tokenRef, handlersFor, cancel } = useTeamBotDrag({
    zoneAt,
    onLift: useCallback(
      (botId: string) => {
        const bot = dropBot(botId);
        setFeedback(null);
        setToast(null);
        const text =
          bot === null
            ? ""
            : `${bot.name} lifted. Drag it onto a team, or onto a round seat to lead.`;
        setHint(text);
        setLiveHint(bot === null ? "" : `${bot.name} lifted. Pick a team, or a lead seat.`);
      },
      [dropBot],
    ),
    onHover: useCallback(
      (botId: string, zoneId: string | null) => {
        const text = hintFor(botId, zoneId);
        setHint(text);
        setLiveHint(text);
      },
      [hintFor],
    ),
    onDrop: dropOn,
    onCancel: useCallback(
      (botId: string) => {
        const bot = dropBot(botId);
        setLiveHint(bot === null ? "" : `${bot.name} stayed where it was.`);
      },
      [dropBot],
    ),
  });

  const cancelMove = useCallback(() => {
    const botId = tapBotId ?? drag?.botId ?? null;
    const bot = botId === null ? null : dropBot(botId);
    cancel();
    setTapBotId(null);
    setLiveHint(bot === null ? "" : `${bot.name} stayed where it was.`);
    if (botId !== null) focusBot(botId);
  }, [cancel, drag, dropBot, focusBot, tapBotId]);

  const overlayBotId = drag?.botId ?? tapBotId;
  const overlayBot = overlayBotId === null ? undefined : botById.get(overlayBotId);
  const moveRows = useMemo(() => {
    if (overlayBotId === null) return [];
    const bot = dropBot(overlayBotId);
    return bot === null ? [] : teamMoveTargets(bot, groups, dropBots, openHandoffsBy);
  }, [dropBot, dropBots, groups, openHandoffsBy, overlayBotId]);
  const facesByTeam = useMemo(() => {
    const map = new Map<string, PersonalBot[]>();
    for (const group of groups) {
      map.set(
        group.team,
        [...(group.leadBotId === null ? [] : [group.leadBotId]), ...group.memberBotIds].flatMap(
          (id) => {
            const bot = botById.get(id);
            return bot === undefined || id === overlayBotId ? [] : [bot];
          },
        ),
      );
    }
    return map;
  }, [botById, groups, overlayBotId]);
  const leadBots = useMemo(() => {
    const map = new Map<string, PersonalBot>();
    for (const group of groups) {
      const lead = group.leadBotId === null ? undefined : botById.get(group.leadBotId);
      if (lead !== undefined) map.set(lead.botId, lead);
    }
    return map;
  }, [botById, groups]);
  const hotTone: "info" | "review" = useMemo(() => {
    if (drag === null || drag.zoneId === null) return "info";
    const target = zoneTargets.get(drag.zoneId);
    const bot = dropBot(drag.botId);
    if (target === undefined || bot === null) return "info";
    return teamDropOutcome(bot, target, dropBots).kind === "blocked" ? "review" : "info";
  }, [drag, dropBot, dropBots, zoneTargets]);

  const removeTeam = useCallback(
    async (team: string) => {
      if (environmentId === null || removing) return;
      setRemoving(true);
      setFeedback(null);
      try {
        const result = await saveProfile({
          environmentId,
          input: { teamChange: { operation: "delete", name: team.trim() } },
        });
        if (result._tag !== "Success") {
          setFeedback({
            tone: "error",
            text: commandFailureMessage(result, "Couldn't remove the team. Try again.") ?? "",
          });
        }
      } finally {
        setRemoving(false);
      }
    },
    [environmentId, removing, saveProfile],
  );

  // The cards are one memoised element. While a finger drags, the hint, the lit
  // drop card and the banner change under it, and none of that may render the
  // constellations again: the layout under the overlay is frozen for the drag.
  const draggingBotId = drag?.botId ?? null;
  const movingBotId = pending?.botId ?? null;
  const cards = useMemo(
    () =>
      groups.map((group) => {
        const lead = group.leadBotId === null ? undefined : botById.get(group.leadBotId);
        const members = group.memberBotIds.flatMap((id) => {
          const bot = botById.get(id);
          return bot === undefined ? [] : [entryOf(bot)];
        });
        const spokes = new Map<string, ConstellationSpoke>();
        for (const entry of counts) {
          if (entry.from !== group.leadBotId) continue;
          spokes.set(entry.to, { recent: entry.recent, running: entry.running > 0 });
        }
        const custom = customTeams.some((registered) => sameTeam(registered, group.team));
        return (
          <TeamConstellationCard
            key={group.team}
            group={group}
            label={group.label}
            lead={lead === undefined ? null : entryOf(lead)}
            members={members}
            spokes={spokes}
            maxSpoke={maxSpoke}
            custom={custom}
            removable={lead === undefined && members.length === 0}
            removeBusy={removing || offline}
            draggingBotId={draggingBotId}
            movingBotId={movingBotId}
            handlersFor={handlersFor}
            onOpenMembers={setMembersTeam}
            onRemove={(team) => void removeTeam(team)}
          />
        );
      }),
    [
      botById,
      counts,
      customTeams,
      draggingBotId,
      entryOf,
      groups,
      handlersFor,
      maxSpoke,
      movingBotId,
      offline,
      removeTeam,
      removing,
    ],
  );

  const onPick = useCallback(
    (zoneId: string) => {
      if (tapBotId === null) return;
      if (zoneId === NEW_TEAM_ZONE_ID) {
        setNewTeamBotId(tapBotId);
        setTapBotId(null);
        return;
      }
      const target = zoneTargets.get(zoneId);
      if (target !== undefined) applyMove(tapBotId, target, false);
    },
    [applyMove, tapBotId, zoneTargets],
  );

  const confirmBot = confirm === null ? null : (botById.get(confirm.botId) ?? null);
  const confirmCopy =
    confirm === null || confirmBot === null
      ? null
      : leadConfirmCopy({
          bot: dropBot(confirm.botId) ?? { botId: confirm.botId, name: confirmBot.name },
          team: confirm.target.team,
          replaced: confirm.replaced,
        });

  const membersGroup =
    membersTeam === null
      ? null
      : (groups.find((group) => sameTeam(group.team, membersTeam)) ?? null);
  const memberRows: ReadonlyArray<MemberListRow> = useMemo(() => {
    if (membersGroup === null) return [];
    const ids = [
      ...(membersGroup.leadBotId === null ? [] : [membersGroup.leadBotId]),
      ...membersGroup.memberBotIds,
    ];
    return ids.flatMap((id) => {
      const bot = botById.get(id);
      return bot === undefined
        ? []
        : [
            {
              bot,
              modelLabel: modelLabels.get(id) ?? null,
              isLead: id === membersGroup.leadBotId,
              live: liveBotIds.has(id),
            },
          ];
    });
  }, [botById, liveBotIds, membersGroup, modelLabels]);

  const newTeamBot = newTeamBotId === null ? null : (botById.get(newTeamBotId) ?? null);
  const dismissToast = useCallback(() => setToast(null), []);

  return (
    <>
      <div className="mt-1 mb-3 flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--personal-primary)] text-base font-bold text-[var(--personal-primary-text)]"
        >
          {initialOf(ownerName)}
        </span>
        <p className="min-w-0">
          <span className="block truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
            {ownerName}
          </span>
          <span className="block text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
            {groups.length} {groups.length === 1 ? "team" : "teams"} · {shown.length}{" "}
            {shown.length === 1 ? "bot" : "bots"} · hold a bot to move it
          </span>
        </p>
      </div>
      <span aria-live="polite" role="status" className="sr-only">
        {liveHint}
      </span>
      {feedback === null ? null : (
        <div
          role={feedback.tone === "error" ? "alert" : "status"}
          className={`mb-3 rounded-[var(--personal-radius-card)] border px-4 py-2.5 text-[15px] leading-snug ${
            feedback.tone === "error"
              ? "border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] text-[var(--personal-text)]"
              : "border-[var(--personal-border)] bg-[var(--personal-surface)] text-[var(--personal-text)]"
          }`}
        >
          {feedback.text}
        </div>
      )}

      <TeamWorkingNow items={working} botsById={botById} nowMs={nowMs} />

      <div ref={containerRef}>{cards}</div>

      {overlayBot === undefined ? null : (
        <TeamMoveOverlay
          bot={overlayBot}
          rows={moveRows}
          facesByTeam={facesByTeam}
          leadBots={leadBots}
          hotZoneId={drag?.zoneId ?? null}
          hint={hint}
          hintTone={hotTone}
          tokenRef={drag === null ? null : tokenRef}
          interactive={drag === null}
          onPick={onPick}
          onNewTeam={() => onPick(NEW_TEAM_ZONE_ID)}
          onCancel={cancelMove}
        />
      )}

      {confirm === null || confirmCopy === null || confirmBot === null ? null : (
        <TeamLeadConfirm
          copy={confirmCopy}
          newLead={confirmBot}
          oldLead={botById.get(confirm.replaced.oldLeadId) ?? null}
          busy={false}
          onCancel={() => {
            setLiveHint(`${confirmBot.name} stayed where it was.`);
            setConfirm(null);
            focusBot(confirm.botId);
          }}
          onConfirm={() => {
            const { botId, target } = confirm;
            setConfirm(null);
            applyMove(botId, target, true);
          }}
        />
      )}

      {membersGroup === null ? null : (
        <TeamMembersSheet
          teamLabel={membersGroup.label}
          rows={memberRows}
          onClose={() => setMembersTeam(null)}
          onMove={(botId) => {
            setMembersTeam(null);
            const bot = dropBot(botId);
            setHint(
              bot === null ? "" : `Tap a team or a lead seat to move ${bot.name}, or cancel.`,
            );
            setLiveHint(bot === null ? "" : `Move ${bot.name}. Pick a team, or a lead seat.`);
            setTapBotId(botId);
          }}
        />
      )}

      {newTeamBot === null ? null : (
        <Sheet open onOpenChange={(next) => (next ? undefined : setNewTeamBotId(null))}>
          <SheetPopup
            side="bottom"
            showCloseButton={false}
            forceBackdrop
            backdropClassName="bg-black/[0.32] backdrop-blur-none dark:bg-black/[0.55]"
            className="personal-app max-h-[92dvh] rounded-t-[20px] border-[var(--personal-border)] bg-[var(--personal-surface)] pb-[env(safe-area-inset-bottom)]"
          >
            <SheetTitle className="px-5 pt-4 text-[19px] leading-6 font-bold text-[var(--personal-text)]">
              New team with {newTeamBot.name}
            </SheetTitle>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3">
              <NewTeamForm
                environmentId={environmentId}
                bots={allBots}
                customTeams={customTeams}
                initialMemberIds={[newTeamBot.botId]}
                onCancel={() => setNewTeamBotId(null)}
                onCreated={(notice) => {
                  setNewTeamBotId(null);
                  onCreated(notice);
                }}
              />
            </div>
          </SheetPopup>
        </Sheet>
      )}

      {toast === null ? null : (
        <TeamMoveToast text={toast.text} onUndo={toast.undo} onDismiss={dismissToast} />
      )}
    </>
  );
}

/**
 * /bots/team: teams as constellations, and current or recent handoffs. Also
 * the desktop pane when no chat is open, where it is the home and has no Back.
 */
export function TeamScreen({ showBack = true }: { readonly showBack?: boolean }): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const list = usePersonalBotsList(environmentId);
  const profile = usePersonalProfile(environmentId);
  const { tasks: taskFeed } = usePersonalTasks(environmentId);
  const allShells = useThreadShells();
  // How the screen was left the last time a page was opened from it. Read once:
  // a later visit that is not a Back starts at the top.
  const savedView = useLocation({
    select: (location) =>
      parseTeamView((location.state as unknown as Record<string, unknown>)[TEAM_VIEW_STATE_KEY]),
  });
  const [initialView] = useState(savedView);
  const bots = useMemo(
    () => (list.data?.bots ?? NO_BOTS).toSorted((left, right) => left.sortOrder - right.sortOrder),
    [list.data],
  );
  // Group-only bots stay out of the chart, as they do out of Chats (leads
  // excepted).
  const chartBots = useMemo(() => shownInTeamChart(bots), [bots]);
  const feedTasks = useMemo(() => (taskFeed === null ? [] : [...taskFeed.values()]), [taskFeed]);
  const tasks = useTeamHandoffTasks(environmentId, feedTasks, taskFeed !== null);
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
  // Set by the New team screen (taken once, after mount) or by the form here.
  // The status region is always in the page and only its text arrives later,
  // which is what makes a screen reader announce it.
  const [notice, setNotice] = useState<TeamNotice | null>(null);
  useEffect(() => {
    const arrived = takeTeamNotice();
    if (arrived !== null) setNotice(arrived);
  }, []);

  return (
    <div className="flex min-h-full flex-col px-5 pb-8">
      <PersonalPageHeader title="Team" showBack={showBack}>
        <Link
          to="/bots/teams/new"
          aria-label="New team"
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--personal-fill-muted)] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <Plus aria-hidden="true" className="size-[22px]" strokeWidth={2} />
        </Link>
      </PersonalPageHeader>
      <div
        role="status"
        aria-live="polite"
        className={
          notice === null
            ? "sr-only"
            : "mb-3 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-4 py-2.5 text-[15px] leading-snug text-[var(--personal-text)]"
        }
      >
        {notice?.message ?? ""}
      </div>
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
        <TeamBoard
          bots={chartBots}
          allBots={bots}
          ownerName={ownerName}
          tasks={tasks}
          liveBotIds={liveBotIds}
          environmentId={environmentId}
          customTeams={profile.data?.customTeams ?? []}
          focusTeam={notice?.team ?? null}
          onCreated={setNotice}
          initialView={initialView}
        />
      ) : null}
    </div>
  );
}
