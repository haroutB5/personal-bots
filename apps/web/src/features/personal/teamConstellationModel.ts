import {
  botTeam,
  isBotOnTeam,
  isTeamLead,
  personalBotTeamLabel,
  sameTeam,
  PERSONAL_TASK_TERMINAL_STATUSES,
  type PersonalBotTeam,
  type PersonalTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  RECENT_DELEGATION_WINDOW_MS,
  teamDropOutcome,
  type TeamDropBot,
  type TeamDropOutcome,
  type TeamDropTarget,
  type TeamGroup,
} from "./teamDiagramModel";

/*
 * Direction B, "Constellation": each team is a card, its lead is the hub in the
 * middle and the members orbit it. Everything that decides where a node sits is
 * a pure function here, so "no two nodes overlap" is a test and not a hope.
 */

/** A node's own width: the name column under a 40 px avatar. */
export const NODE_WIDTH = 76;
export const NODE_AVATAR = 40;
/** The name wraps to at most two lines of 15 px under the avatar. */
const NODE_LINE_HEIGHT = 15;
/** What a 12 px semibold character is taken to measure, a little wide so a label never under-reserves. */
const CHAR_WIDTH = 5.9;
/** Longest name that stays on one line in a 76 px column. */
const ONE_LINE_CHARS = 12;

/** The room a node's name takes under its avatar. */
export interface NodeLabel {
  readonly lines: 1 | 2;
  readonly width: number;
}

const WIDEST_LABEL: NodeLabel = { lines: 2, width: NODE_WIDTH };

/**
 * How a name sits under its avatar: one line as wide as the name, or two lines
 * as wide as the column. Estimated, not measured, so the layout is a pure
 * function of the names; the estimate errs wide (a node that reserves room it
 * does not use only leaves air, one that under-reserves touches its neighbour).
 */
export function nodeLabel(name: string): NodeLabel {
  const length = Array.from(name.trim()).length;
  if (length > ONE_LINE_CHARS) return WIDEST_LABEL;
  return {
    lines: 1,
    width: Math.min(NODE_WIDTH, Math.max(28, Math.ceil(length * CHAR_WIDTH + 8))),
  };
}
export const HUB_DISC = 72;
/** Most nodes a card draws. Past this the last seat reads "+N" and opens the full list. */
export const MAX_ORBIT_NODES = 20;

export interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const box = (cx: number, cy: number, halfW: number, top: number, bottom: number): Box => ({
  x0: cx - halfW,
  y0: cy + top,
  x1: cx + halfW,
  y1: cy + bottom,
});

/**
 * What a node occupies around its avatar centre: the avatar, and the name
 * column below it at the widest and tallest it can be. Two boxes rather than
 * one so an avatar can sit next to the empty corner of a neighbour's label.
 */
export function nodeBoxes(
  x: number,
  y: number,
  label: NodeLabel = WIDEST_LABEL,
): ReadonlyArray<Box> {
  return [
    box(x, y, NODE_AVATAR / 2, -NODE_AVATAR / 2, NODE_AVATAR / 2),
    box(
      x,
      y,
      label.width / 2,
      NODE_AVATAR / 2 + 3,
      NODE_AVATAR / 2 + 3 + NODE_LINE_HEIGHT * label.lines,
    ),
  ];
}

/** The hub: its disc, the name pill across its lower edge and the model label under it. */
export function hubBoxes(x: number, y: number): ReadonlyArray<Box> {
  return [
    box(x, y, HUB_DISC / 2, -HUB_DISC / 2, HUB_DISC / 2),
    box(x, y, 66, HUB_DISC / 2 - 12, HUB_DISC / 2 + 14),
    box(x, y, 44, HUB_DISC / 2 + 14, HUB_DISC / 2 + 32),
  ];
}

const overlaps = (a: Box, b: Box, gap: number): boolean =>
  a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;

/** Whether two sets of boxes touch, leaving `gap` px clear between them. */
export function boxesCollide(
  a: ReadonlyArray<Box>,
  b: ReadonlyArray<Box>,
  gap: number = 2,
): boolean {
  return a.some((left) => b.some((right) => overlaps(left, right, gap)));
}

export interface ConstellationSlot {
  /** Avatar centre, in the sky's own pixels (origin at its top-left). */
  readonly x: number;
  readonly y: number;
  /** 0 is the inner orbit. */
  readonly ring: number;
}

export interface ConstellationLayout {
  readonly width: number;
  readonly height: number;
  readonly hub: { readonly x: number; readonly y: number };
  /** One per drawn member, in member order; the last is the "+N" seat when `hidden` > 0. */
  readonly slots: ReadonlyArray<ConstellationSlot>;
  /** The label room each slot reserved. */
  readonly lines: ReadonlyArray<NodeLabel>;
  /** Members that do not fit and sit behind the "+N" seat. */
  readonly hidden: number;
  /** Elliptical guides for the dotted orbits. */
  readonly orbits: ReadonlyArray<{ readonly rx: number; readonly ry: number }>;
}

interface RawSlot {
  readonly x: number;
  readonly y: number;
  readonly ring: number;
}
interface Orbit {
  readonly rx: number;
  readonly ry: number;
}
interface Plan {
  readonly slots: ReadonlyArray<RawSlot>;
  readonly orbits: ReadonlyArray<Orbit>;
}

const ringPoints = (
  count: number,
  orbit: Orbit,
  phase: number,
  ring: number,
): ReadonlyArray<RawSlot> =>
  Array.from({ length: count }, (_, index) => {
    const angle = phase + (index * 2 * Math.PI) / count;
    return { x: orbit.rx * Math.cos(angle), y: orbit.ry * Math.sin(angle), ring };
  });

type Lines = ReadonlyArray<NodeLabel>;
const linesAt = (lines: Lines, index: number): NodeLabel => lines[index] ?? WIDEST_LABEL;

/** True when nothing in the plan touches the hub, another node, or leaves the card. */
function fits(plan: Plan, halfWidth: number, lines: Lines): boolean {
  const hub = hubBoxes(0, 0);
  const placed = plan.slots.map((slot, index) => nodeBoxes(slot.x, slot.y, linesAt(lines, index)));
  for (const [index, boxes] of placed.entries()) {
    const slot = plan.slots[index]!;
    if (Math.abs(slot.x) + NODE_WIDTH / 2 > halfWidth) return false;
    if (boxesCollide(boxes, hub)) return false;
    for (let other = 0; other < index; other += 1) {
      if (boxesCollide(boxes, placed[other]!)) return false;
    }
  }
  return true;
}

const extent = (plan: Plan, lines: Lines): { top: number; bottom: number } => {
  const all = [
    ...hubBoxes(0, 0),
    ...plan.slots.flatMap((slot, index) => nodeBoxes(slot.x, slot.y, linesAt(lines, index))),
  ];
  return {
    top: Math.min(...all.map((entry) => entry.y0)),
    bottom: Math.max(...all.map((entry) => entry.y1)),
  };
};

const height = (plan: Plan, lines: Lines): number => {
  const { top, bottom } = extent(plan, lines);
  return bottom - top;
};

/** The few (rx, ry) pairs tried for a single orbit, roomiest last. */
function singleOrbits(maxRx: number, count: number): ReadonlyArray<Orbit> {
  const rxs = [...new Set([Math.min(maxRx, 112), Math.min(maxRx, 133), maxRx])];
  const rys = count <= 2 ? [0, 44] : [74, 98, 122, 146, 170, 194, 218, 242];
  return rys.flatMap((ry) => rxs.map((rx) => ({ rx, ry })));
}

/** The mockup's own orbit for one card: kept first so a normal team reads exactly as designed. */
function designedPlan(count: number, maxRx: number): Plan {
  const rx = count <= 2 ? Math.min(maxRx, 112) : Math.min(maxRx, 140);
  const ry = count > 5 ? 122 : count <= 2 ? 44 : 74;
  const phase = count === 1 ? 0 : -Math.PI / 2 + (count === 4 ? Math.PI / 4 : 0);
  const orbit = { rx, ry };
  return { slots: ringPoints(count, orbit, phase, 0), orbits: [orbit] };
}

/**
 * Members beyond one orbit go on a second: taller, staggered half a step so a
 * node on the outside sits between two on the inside, and every spoke to the
 * outer ring runs through the gap.
 */
function twoOrbitPlans(count: number, maxRx: number, lines: Lines): ReadonlyArray<Plan> {
  const plans: Plan[] = [];
  const inner: ReadonlyArray<Orbit> = [
    { rx: Math.min(maxRx, 104), ry: 92 },
    { rx: Math.min(maxRx, 112), ry: 104 },
    { rx: Math.min(maxRx, 118), ry: 116 },
    { rx: Math.min(maxRx, 124), ry: 128 },
    { rx: Math.min(maxRx, 124), ry: 140 },
  ];
  const outerRys = [178, 196, 214, 232, 250, 270, 290, 310, 330, 350];
  for (let innerCount = Math.ceil(count * 0.4); innerCount <= count - 1; innerCount += 1) {
    const outerCount = count - innerCount;
    for (const innerOrbit of inner) {
      for (const outerRy of outerRys) {
        const outerOrbit = { rx: maxRx, ry: outerRy };
        plans.push({
          slots: [
            ...ringPoints(innerCount, innerOrbit, -Math.PI / 2, 0),
            ...ringPoints(outerCount, outerOrbit, -Math.PI / 2 + Math.PI / outerCount, 1),
          ],
          orbits: [innerOrbit, outerOrbit],
        });
      }
    }
  }
  return plans.toSorted((left, right) => height(left, lines) - height(right, lines));
}

/**
 * Last resort: first-fit on three growing orbits. It always ends collision-free
 * (a candidate is only taken when nothing touches it), so a strange width or a
 * very full team still draws every node, if a little untidily.
 */
function packedPlan(count: number, maxRx: number, lines: Lines): Plan {
  const hub = hubBoxes(0, 0);
  const taken: RawSlot[] = [];
  for (let ring = 0; taken.length < count && ring < 8; ring += 1) {
    const orbit = { rx: Math.min(maxRx, 104 + ring * 20), ry: 100 + ring * 84 };
    for (let step = 0; step < 120 && taken.length < count; step += 1) {
      const angle = -Math.PI / 2 + (step * 2 * Math.PI) / 120;
      const candidate = {
        x: orbit.rx * Math.cos(angle),
        y: orbit.ry * Math.sin(angle),
        ring,
      };
      if (Math.abs(candidate.x) + NODE_WIDTH / 2 > maxRx + NODE_WIDTH / 2) continue;
      const boxes = nodeBoxes(candidate.x, candidate.y, linesAt(lines, taken.length));
      if (boxesCollide(boxes, hub)) continue;
      if (
        taken.some((other, index) =>
          boxesCollide(boxes, nodeBoxes(other.x, other.y, linesAt(lines, index))),
        )
      ) {
        continue;
      }
      taken.push(candidate);
    }
  }
  // The nodes sit where they fit, not on a curve: no guide ellipses to mislead.
  return { slots: taken, orbits: [] };
}

const HEIGHT_PADDING = { top: 10, bottom: 12 } as const;

/**
 * Where the hub and each member sit in a sky `width` px wide. Every plan is
 * checked for overlaps before it is used; the order is the designed single
 * orbit, other single orbits, two staggered orbits, then a packed fallback.
 */
export function buildConstellationLayout(
  /** Each member's name label, in member order ({@link nodeLabel}). */
  memberLines: ReadonlyArray<NodeLabel>,
  width: number,
): ConstellationLayout {
  const memberCount = memberLines.length;
  const skyWidth = Math.max(NODE_WIDTH * 2 + 40, Math.round(width));
  const halfWidth = skyWidth / 2;
  const maxRx = halfWidth - NODE_WIDTH / 2 - 2;
  const drawn = Math.min(memberCount, MAX_ORBIT_NODES);
  // The "+N" seat has no name to wrap: it is one short line.
  const lines: Lines =
    memberCount > MAX_ORBIT_NODES
      ? [...memberLines.slice(0, MAX_ORBIT_NODES - 1), { lines: 1, width: 56 }]
      : memberLines;
  const hidden = memberCount > MAX_ORBIT_NODES ? memberCount - (MAX_ORBIT_NODES - 1) : 0;

  let plan: Plan;
  if (drawn === 0) {
    plan = { slots: [], orbits: [] };
  } else {
    const designed = designedPlan(drawn, maxRx);
    const candidates: Plan[] = [
      designed,
      ...singleOrbits(maxRx, drawn).flatMap((orbit) => {
        const phases =
          drawn === 1 ? [0] : drawn === 2 ? [0] : [-Math.PI / 2, -Math.PI / 2 + Math.PI / drawn];
        return phases.map((phase) => ({
          slots: ringPoints(drawn, orbit, phase, 0),
          orbits: [orbit],
        }));
      }),
    ];
    const singleOk = candidates.filter((candidate) => fits(candidate, halfWidth, lines));
    // The designed orbit wins outright when it fits; otherwise the shortest single orbit.
    const single = fits(designed, halfWidth, lines)
      ? designed
      : singleOk.toSorted((left, right) => height(left, lines) - height(right, lines))[0];
    plan =
      single ??
      twoOrbitPlans(drawn, maxRx, lines).find((candidate) => fits(candidate, halfWidth, lines)) ??
      packedPlan(drawn, maxRx, lines);
  }

  const { top, bottom } = extent(plan, lines);
  const hubY = HEIGHT_PADDING.top - top;
  return {
    width: skyWidth,
    height: Math.ceil(bottom - top + HEIGHT_PADDING.top + HEIGHT_PADDING.bottom),
    hub: { x: halfWidth, y: hubY },
    slots: plan.slots.map((slot) => ({ x: halfWidth + slot.x, y: hubY + slot.y, ring: slot.ring })),
    lines,
    hidden,
    orbits: plan.orbits,
  };
}

/** Every drawn node's boxes, for tests and for checking a layout by eye. */
export function layoutCollisions(layout: ConstellationLayout): number {
  const hub = hubBoxes(layout.hub.x, layout.hub.y);
  const placed = layout.slots.map((slot, index) =>
    nodeBoxes(slot.x, slot.y, linesAt(layout.lines, index)),
  );
  let clashes = 0;
  for (const [index, boxes] of placed.entries()) {
    if (boxesCollide(boxes, hub)) clashes += 1;
    for (let other = 0; other < index; other += 1) {
      if (boxesCollide(boxes, placed[other]!)) clashes += 1;
    }
  }
  return clashes;
}

/** A spoke never starts farther from the hub's centre than this. */
const HUB_SPOKE_MAX_START = 130;

const containsPoint = (entry: Box, x: number, y: number, gap: number): boolean =>
  x > entry.x0 - gap && x < entry.x1 + gap && y > entry.y0 - gap && y < entry.y1 + gap;

/** Where a spoke runs: from just outside the hub to just short of the node's avatar. */
export function spokeLine(
  hub: { readonly x: number; readonly y: number },
  slot: { readonly x: number; readonly y: number },
): { x1: number; y1: number; x2: number; y2: number } | null {
  const dx = slot.x - hub.x;
  const dy = slot.y - hub.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 90) return null;
  const ux = dx / distance;
  const uy = dy / distance;
  // Leaves the hub at its ring, but a line heading down or diagonally down would start behind the
  // name pill and the model label under the disc ("CTO Lead", "Sonnet 5.5"), so it starts only
  // where it is clear of every one of them.
  const around = hubBoxes(hub.x, hub.y);
  // A ray can leave the disc and then run through the pill, so the start is after the last
  // point of the ray that is inside any of them, not the first point outside.
  let start = 42;
  for (let travelled = 42; travelled <= HUB_SPOKE_MAX_START; travelled += 1) {
    const x = hub.x + ux * travelled;
    const y = hub.y + uy * travelled;
    if (around.some((entry) => containsPoint(entry, x, y, 3))) start = travelled + 1;
  }
  // Nothing left between the hub's own labels and the avatar: no line, the count shows on the node.
  if (distance - 25 - start < 12) return null;
  return {
    x1: hub.x + ux * start,
    y1: hub.y + uy * start,
    x2: slot.x - ux * 25,
    y2: slot.y - uy * 25,
  };
}

/**
 * Whether the spoke to member `index` reaches it without running behind another
 * node. On a single orbit it always does; on a crowded card a line to an outer
 * node can pass an inner one, and a line hidden behind a name reads as a line
 * to the wrong bot. Those handoffs are shown as a count on the node instead.
 */
export function spokeIsClear(layout: ConstellationLayout, index: number): boolean {
  const slot = layout.slots[index];
  if (slot === undefined) return false;
  const line = spokeLine(layout.hub, slot);
  if (line === null) return false;
  const others = layout.slots.flatMap((other, position) =>
    position === index ? [] : nodeBoxes(other.x, other.y, linesAt(layout.lines, position)),
  );
  const length = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
  for (let travelled = 0; travelled <= length; travelled += 3) {
    const x = line.x1 + ((line.x2 - line.x1) * travelled) / length;
    const y = line.y1 + ((line.y2 - line.y1) * travelled) / length;
    if (
      others.some(
        (entry) => x > entry.x0 - 2 && x < entry.x1 + 2 && y > entry.y0 - 2 && y < entry.y1 + 2,
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Thicker for more handoffs, on a square-root scale so 2 and 38 are both legible. */
export function spokeWidth(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 0;
  return Number((1.25 + 4.5 * Math.sqrt(Math.min(1, count / maxCount))).toFixed(2));
}

export interface DelegationCount {
  readonly from: string;
  readonly to: string;
  /** Finished, failed or cancelled handoffs in the last 7 days. */
  readonly recent: number;
  /** Handoffs still open now. */
  readonly running: number;
}

/**
 * The same filter as `deriveDelegationLinks`, counting instead of deduplicating:
 * one entry per sender and receiver with how many handoffs ran this week and how
 * many are running now.
 */
export function deriveDelegationCounts(
  tasks: ReadonlyArray<PersonalTask>,
  botIds: ReadonlySet<string>,
  nowMs: number,
): DelegationCount[] {
  const tasksById = new Map(tasks.map((task) => [task.taskId as string, task] as const));
  const counts = new Map<string, { from: string; to: string; recent: number; running: number }>();
  const cutoff = nowMs - RECENT_DELEGATION_WINDOW_MS;
  for (const child of tasks) {
    if (child.parentTaskId === null) continue;
    const parent = tasksById.get(child.parentTaskId as string);
    if (parent === undefined) continue;
    const from = parent.botId as string;
    const to = child.botId as string;
    if (from === to || !botIds.has(from) || !botIds.has(to)) continue;
    const terminal = PERSONAL_TASK_TERMINAL_STATUSES.includes(child.status);
    if (terminal) {
      const completedMs = DateTime.toEpochMillis(child.completedAt ?? child.updatedAt);
      if (completedMs < cutoff) continue;
    }
    const key = `${from}\u0000${to}`;
    const entry = counts.get(key) ?? { from, to, recent: 0, running: 0 };
    if (terminal) entry.recent += 1;
    else entry.running += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].toSorted(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

/**
 * Whether a page of finished tasks (newest first) already reaches back past the
 * week the spokes count, so no older page is needed.
 */
export function historyReachesCutoff(
  page: ReadonlyArray<Pick<PersonalTask, "completedAt" | "updatedAt">>,
  nowMs: number,
): boolean {
  const oldest = page.at(-1);
  if (oldest === undefined) return true;
  return (
    DateTime.toEpochMillis(oldest.completedAt ?? oldest.updatedAt) <
    nowMs - RECENT_DELEGATION_WINDOW_MS
  );
}

/** One handoff that is running now, for the "Working now" card. */
export interface WorkingNowItem {
  readonly taskId: string;
  readonly from: string;
  readonly to: string;
  readonly title: string;
  /** The receiving bot's task chat, when the task has one yet. */
  readonly threadId: string | null;
  readonly sinceMs: number;
}

/** Running handoffs between bots that are on the screen, oldest first. */
export function deriveWorkingNow(
  tasks: ReadonlyArray<PersonalTask>,
  botIds: ReadonlySet<string>,
): WorkingNowItem[] {
  const tasksById = new Map(tasks.map((task) => [task.taskId as string, task] as const));
  const items: WorkingNowItem[] = [];
  for (const child of tasks) {
    if (child.parentTaskId === null) continue;
    if (PERSONAL_TASK_TERMINAL_STATUSES.includes(child.status)) continue;
    const parent = tasksById.get(child.parentTaskId as string);
    if (parent === undefined) continue;
    const from = parent.botId as string;
    const to = child.botId as string;
    if (from === to || !botIds.has(from) || !botIds.has(to)) continue;
    items.push({
      taskId: child.taskId as string,
      from,
      to,
      title: child.title,
      threadId: child.threadId === null ? null : (child.threadId as string),
      sinceMs: DateTime.toEpochMillis(child.startedAt ?? child.createdAt),
    });
  }
  return items.toSorted((left, right) => left.sinceMs - right.sinceMs);
}

/** "5 min", "1 h", "1 h 9 min": how long a handoff has been running. */
export function formatWorkingFor(sinceMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/**
 * Where tapping a "Working now" row goes: the receiving bot's task chat, or
 * the task's own page while it has no chat yet.
 */
export type WorkingNowTarget =
  | { readonly to: "/bots/$botId/$threadId"; readonly params: { botId: string; threadId: string } }
  | { readonly to: "/tasks/$taskId"; readonly params: { taskId: string } };

export function workingNowTarget(item: WorkingNowItem): WorkingNowTarget {
  return item.threadId === null
    ? { to: "/tasks/$taskId", params: { taskId: item.taskId } }
    : { to: "/bots/$botId/$threadId", params: { botId: item.to, threadId: item.threadId } };
}

/* ── Moving a bot ─────────────────────────────────────────────────────────── */

export interface LeadReplacement {
  readonly oldLeadId: string;
  readonly oldLeadName: string;
  /** Handoffs the old lead has open; they carry on. */
  readonly openHandoffs: number;
}

/** The lead a Lead drop would replace, or null when the seat is empty or already the bot's. */
export function replacedLead(
  bot: TeamDropBot,
  team: PersonalBotTeam,
  roster: ReadonlyArray<TeamDropBot>,
  openHandoffsBy: (botId: string) => number = () => 0,
): LeadReplacement | null {
  const current = roster.find(
    (other) => other.botId !== bot.botId && isBotOnTeam(other, team) && isTeamLead(other),
  );
  if (current === undefined) return null;
  return {
    oldLeadId: current.botId,
    oldLeadName: current.name,
    openHandoffs: openHandoffsBy(current.botId),
  };
}

export interface LeadConfirmCopy {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  readonly confirmLabel: string;
}

/** The action sheet for taking over a team's lead seat. */
export function leadConfirmCopy(input: {
  readonly bot: TeamDropBot;
  readonly team: PersonalBotTeam;
  readonly replaced: LeadReplacement;
}): LeadConfirmCopy {
  const { bot, team, replaced } = input;
  const teamLabel = personalBotTeamLabel(team);
  const lines = [`${replaced.oldLeadName} stops leading and stays on the ${teamLabel}.`];
  if (replaced.openHandoffs > 0) {
    lines.push(
      `${replaced.oldLeadName} has ${String(replaced.openHandoffs)} ${
        replaced.openHandoffs === 1 ? "handoff" : "handoffs"
      } running; ${replaced.openHandoffs === 1 ? "it carries" : "they carry"} on.`,
    );
  }
  // The bot leaves a team whose only member it is: that team is left empty.
  if (isTeamLead(bot) && !sameTeam(botTeam(bot), team)) {
    const from = personalBotTeamLabel(botTeam(bot));
    lines.push(
      `${bot.name} leads ${from}; it will move to ${teamLabel}, and ${from} will have no lead.`,
    );
  }
  return {
    title: `Make ${bot.name} the ${teamLabel} lead?`,
    lines,
    confirmLabel: `Make ${bot.name} lead`,
  };
}

export interface MoveTargetRow {
  readonly team: PersonalBotTeam;
  readonly label: string;
  /** Members including the lead, not counting the bot being moved. */
  readonly memberCount: number;
  readonly leadName: string | null;
  readonly leadBotId: string | null;
  /** The bot's own team: nothing to join. */
  readonly here: boolean;
  readonly join: TeamDropOutcome;
  readonly lead: TeamDropOutcome;
  /** Set when the Lead drop would replace someone: ask first. */
  readonly replaces: LeadReplacement | null;
}

/**
 * One row per team for the drop cards: what joining it and taking its lead
 * seat would do, so the cards never re-derive the rules the drop itself uses.
 */
export function teamMoveTargets(
  bot: TeamDropBot,
  groups: ReadonlyArray<TeamGroup>,
  roster: ReadonlyArray<TeamDropBot>,
  openHandoffsBy?: (botId: string) => number,
): MoveTargetRow[] {
  const names = new Map(roster.map((entry) => [entry.botId, entry.name] as const));
  return groups.map((group) => {
    const others = roster.filter(
      (entry) => entry.botId !== bot.botId && isBotOnTeam(entry, group.team),
    );
    const outcomeFor = (kind: "team" | "lead") =>
      teamDropOutcome(bot, { kind, team: group.team }, roster);
    const lead = outcomeFor("lead");
    return {
      team: group.team,
      label: group.label,
      memberCount: others.length,
      leadName: group.leadBotId === null ? null : (names.get(group.leadBotId) ?? null),
      leadBotId: group.leadBotId,
      here: sameTeam(botTeam(bot), group.team),
      join: outcomeFor("team"),
      lead,
      replaces:
        lead.kind === "update" ? replacedLead(bot, group.team, roster, openHandoffsBy) : null,
    };
  });
}

/**
 * A move as the server applies it, so the screen can show it at once: the bot
 * takes its new team and role, and taking a lead seat hands it over in the same
 * write, so nobody ever shows two Lead badges.
 */
export function applyTeamUpdate<
  T extends { readonly botId: string; readonly team?: PersonalBotTeam; readonly lead?: boolean },
>(
  roster: ReadonlyArray<T>,
  update: { readonly botId: string; readonly team: PersonalBotTeam; readonly lead: boolean },
): T[] {
  return roster.map((bot) => {
    if (bot.botId === update.botId) return { ...bot, team: update.team, lead: update.lead };
    if (update.lead && isBotOnTeam(bot, update.team)) return { ...bot, lead: false };
    return bot;
  });
}

export type DropPlan =
  | { readonly kind: "none"; readonly message: string }
  | { readonly kind: "blocked"; readonly message: string }
  /** A Lead drop that replaces someone: ask first, send nothing yet. */
  | {
      readonly kind: "confirm";
      readonly outcome: Extract<TeamDropOutcome, { kind: "update" }>;
      readonly replaced: LeadReplacement;
    }
  | {
      readonly kind: "commit";
      readonly outcome: Extract<TeamDropOutcome, { kind: "update" }>;
      readonly replaced: LeadReplacement | null;
    };

/**
 * What a drop (or a tap on a card) does. Moving a bot is sent at once, except
 * taking over a team's lead seat from somebody: that asks first, because it
 * changes who delegates for the whole team, unless it was already confirmed.
 */
export function planDrop(input: {
  readonly bot: TeamDropBot;
  readonly target: TeamDropTarget;
  readonly roster: ReadonlyArray<TeamDropBot>;
  readonly openHandoffsBy?: (botId: string) => number;
  readonly confirmed?: boolean;
}): DropPlan {
  const outcome = teamDropOutcome(input.bot, input.target, input.roster);
  if (outcome.kind !== "update") return outcome;
  const replaced =
    input.target.kind === "lead"
      ? replacedLead(input.bot, input.target.team, input.roster, input.openHandoffsBy)
      : null;
  if (replaced !== null && input.confirmed !== true) return { kind: "confirm", outcome, replaced };
  return { kind: "commit", outcome, replaced };
}

/** One `personalBots.update` the Undo sends. */
export interface UndoStep {
  readonly botId: string;
  readonly team: PersonalBotTeam;
  readonly lead: boolean;
}

/**
 * How to put a move back. When the move took a lead seat, the old lead gets it
 * back first; then the bot returns to its old team and role. The server hands a
 * seat over in the same write, so nobody is ever left with two Lead badges.
 */
export function undoPlan(input: {
  readonly before: {
    readonly botId: string;
    readonly team: PersonalBotTeam;
    readonly lead: boolean;
  };
  readonly replaced: LeadReplacement | null;
  readonly destination: PersonalBotTeam;
}): UndoStep[] {
  const steps: UndoStep[] = [];
  if (input.replaced !== null) {
    steps.push({ botId: input.replaced.oldLeadId, team: input.destination, lead: true });
  }
  steps.push({ botId: input.before.botId, team: input.before.team, lead: input.before.lead });
  return steps;
}

/** What the live region says once an Undo has gone through. */
export function undoMessage(botName: string, team: PersonalBotTeam, lead: boolean): string {
  const label = personalBotTeamLabel(team);
  return lead ? `${botName} is back as the ${label} lead.` : `${botName} is back on the ${label}.`;
}

/** Which zone a screen point is over, among `zones` measured from the DOM. */
export function zoneIdAtPoint(
  zones: ReadonlyArray<{ readonly id: string; readonly rect: Box }>,
  x: number,
  y: number,
): string | null {
  return (
    zones.find(
      (zone) => x >= zone.rect.x0 && x <= zone.rect.x1 && y >= zone.rect.y0 && y <= zone.rect.y1,
    )?.id ?? null
  );
}
