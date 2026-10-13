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
 * Design A, "Constellation": each team is a card, its lead is the hub in the
 * middle and the members orbit it on one ellipse. The geometry is the design's
 * own (SPEC-final 2.10) rather than searched for, so a team draws the same
 * card every time and every label sits on its own plate; that the labels of a
 * full team never touch is a test on worst-case names ({@link teamLayoutOverlaps}),
 * not a runtime search.
 */

/** A member's own column: the name under a 36 px avatar. */
export const NODE_WIDTH = 92;
export const NODE_AVATAR = 36;
/** How wide a member's name is drawn before it wraps: `-webkit-line-clamp: 2`. */
export const NODE_NAME_WIDTH = 88;
/** The lead's disc and its name column. */
export const HUB_AVATAR = 64;
export const HUB_WIDTH = 160;

/** Member name: 13/16 semibold, at most two lines. Caption: 13/16, one line. */
const NAME_LINE_HEIGHT = 16;
const NAME_LINES = 2;
const CAPTION_HEIGHT = 16;
/** Between the avatar and the name, and between the name and the caption. */
const AVATAR_GAP = 4;
/** Room under the card header before the top avatar, and under the lowest caption. */
const TOP_ROOM = 24;
const BOTTOM_ROOM = 16;

/**
 * Most nodes a card draws. Past this the last seat reads "+N" and opens the
 * full list. The design's single ring stays clean to here even on a 320 px
 * card, where the ring cannot grow any wider; a bigger team is read in the
 * members sheet, which has the room and the Move buttons.
 */
export const MAX_ORBIT_NODES = 16;

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
 * How wide one node's plates are: its name (wrapping to at most two lines in
 * an {@link NODE_NAME_WIDTH} column) and its caption (one line, free to run
 * wider than the name). Estimated from the text, so the overlap check can use
 * a real roster rather than the widest possible labels.
 */
export interface LabelSizes {
  readonly nameWidth: number;
  readonly captionWidth: number;
}

/** The widest a member's plates can be; `{0, 0}` means "avatar only, no labels". */
export const WORST_MEMBER_LABEL: LabelSizes = { nameWidth: NODE_NAME_WIDTH, captionWidth: 96 };
/** The widest the lead's plates can be. */
export const WORST_LEAD_LABEL: LabelSizes = { nameWidth: HUB_WIDTH, captionWidth: 120 };

/** 13 px semibold is about this wide per character; the estimate errs generous. */
const NAME_CHAR_WIDTH = 7;
/** 13 px regular, for captions. */
const CAPTION_CHAR_WIDTH = 6.4;

const chars = (text: string): number => Array.from(text.trim()).length;
const estimate = (text: string, perChar: number): number =>
  text.trim().length === 0 ? 0 : Math.ceil(chars(text) * perChar + 8);

/** A member's plate widths from its own name and caption. */
export function memberLabelSizes(name: string, caption: string): LabelSizes {
  return {
    nameWidth: Math.min(NODE_NAME_WIDTH, estimate(name, NAME_CHAR_WIDTH)),
    captionWidth: Math.min(NODE_WIDTH, estimate(caption, CAPTION_CHAR_WIDTH)),
  };
}

/** The lead's plate widths, capped at its own column. */
export function leadLabelSizes(name: string, caption: string): LabelSizes {
  return {
    nameWidth: Math.min(HUB_WIDTH, estimate(name, NAME_CHAR_WIDTH + 1.4)),
    captionWidth: Math.min(HUB_WIDTH, estimate(caption, CAPTION_CHAR_WIDTH)),
  };
}

/**
 * What a member occupies around its avatar centre: the avatar, then the name
 * plate (one line, or two when the name wraps) and the caption under it. The
 * caption may be wider than the name (a long model label spreads past its
 * column), so it gets its own box.
 */
export function nodeBoxes(x: number, y: number, sizes: LabelSizes = WORST_MEMBER_LABEL): Box[] {
  const avatar: Box = box(x, y, NODE_AVATAR / 2, -NODE_AVATAR / 2, NODE_AVATAR / 2);
  if (sizes.nameWidth <= 0 && sizes.captionWidth <= 0) return [avatar];
  const nameLines = sizes.nameWidth > 0 && sizes.nameWidth < NODE_NAME_WIDTH ? 1 : NAME_LINES;
  const nameHalf = Math.max(NODE_AVATAR / 2, sizes.nameWidth / 2);
  const nameTop = NODE_AVATAR / 2 + AVATAR_GAP;
  const nameBottom = nameTop + NAME_LINE_HEIGHT * nameLines;
  const captionHalf = Math.max(nameHalf, sizes.captionWidth / 2);
  return [
    avatar,
    box(x, y, nameHalf, nameTop, nameBottom),
    box(x, y, captionHalf, nameBottom, nameBottom + CAPTION_HEIGHT),
  ];
}

/**
 * The hub: the crown and disc (the disc is 64 wide, never the plate's width),
 * then the name plate and the caption under it.
 */
export function hubBoxes(x: number, y: number, sizes: LabelSizes = WORST_LEAD_LABEL): Box[] {
  const crown: Box = box(x, y, HUB_AVATAR / 2, -HUB_AVATAR / 2 - 16, HUB_AVATAR / 2);
  if (sizes.nameWidth <= 0 && sizes.captionWidth <= 0) return [crown];
  const nameHalf = Math.max(HUB_AVATAR / 2, sizes.nameWidth / 2);
  const nameTop = HUB_AVATAR / 2;
  const nameBottom = nameTop + NAME_LINE_HEIGHT;
  const captionHalf = Math.max(nameHalf, sizes.captionWidth / 2);
  return [
    crown,
    box(x, y, nameHalf, nameTop, nameBottom),
    box(x, y, captionHalf, nameBottom, nameBottom + CAPTION_HEIGHT + 4),
  ];
}

const overlaps = (a: Box, b: Box, gap: number): boolean =>
  a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;

/**
 * Whether two sets of boxes overlap, leaving `gap` px clear between them. 0
 * (the default) means plates may touch but must not sit on each other: the
 * team card's own check, where a pixel of clearance is a plate's padding, not
 * a collision.
 */
export function boxesCollide(
  a: ReadonlyArray<Box>,
  b: ReadonlyArray<Box>,
  gap: number = 0,
): boolean {
  return a.some((left) => b.some((right) => overlaps(left, right, gap)));
}

export interface ConstellationSlot {
  /** Avatar centre, in the sky's own pixels (origin at its top-left). */
  readonly x: number;
  readonly y: number;
}

export interface ConstellationLayout {
  readonly width: number;
  readonly height: number;
  /** The lead's avatar centre. */
  readonly hub: { readonly x: number; readonly y: number };
  /** One per drawn member, in member order; the last is the "+N" seat when `hidden` > 0. */
  readonly slots: ReadonlyArray<ConstellationSlot>;
  readonly rx: number;
  readonly ry: number;
  /** Members that do not fit and sit behind the "+N" seat. */
  readonly hidden: number;
}

/**
 * The ellipse the design uses: a wide shallow ring for two to five members, and
 * the taller one for six or more - and for a single member, which would land on
 * the lead's own name on the shallow ring. More than eight members open the
 * ring by 16 px each, per the design note.
 */
const orbitFor = (count: number): { readonly rx: number; readonly ry: number } =>
  count >= 2 && count <= 5
    ? { rx: 112, ry: 72 }
    : { rx: 124, ry: 140 + Math.max(0, count - 8) * 16 };

/**
 * Where the lead and each member sit in a sky `width` px wide. Members walk the
 * ellipse from 12 o'clock: from six (or alone) the first one sits exactly there
 * - the crown is above the lead, so the top is free - and with two to five it
 * starts half a step past it, so nobody lands on the lead's name.
 */
export function buildConstellationLayout(
  /** How many members the card draws. */
  count: number,
  width: number,
): ConstellationLayout {
  const skyWidth = Math.max(NODE_WIDTH * 2 + 40, Math.round(width));
  const drawn = Math.min(count, MAX_ORBIT_NODES);
  const hidden = count > MAX_ORBIT_NODES ? count - (MAX_ORBIT_NODES - 1) : 0;
  // The last seat is the "+N" plate when there is overflow; it keeps a seat's
  // own position, so the card draws one node per slot.
  const seats = drawn;
  const halfWidth = skyWidth / 2;
  const designed = orbitFor(seats);
  // A narrow column pulls the ring in rather than let a node run off the card.
  const rx = Math.max(NODE_AVATAR, Math.min(designed.rx, halfWidth - NODE_WIDTH / 2 - 2));
  const ry = designed.ry;
  const step = seats === 0 ? 0 : (2 * Math.PI) / seats;
  const staggered = seats >= 2 && seats <= 5;
  const phase = staggered ? -Math.PI / 2 + step / 2 : -Math.PI / 2;
  const angles = Array.from({ length: seats }, (_, index) => phase + index * step);
  const minSin = angles.length === 0 ? 0 : Math.min(...angles.map(Math.sin));
  // The design places the hub so the top avatar's top is 24 px below the card
  // header; with no member above the hub (a lead alone, or two side by side)
  // the hub itself is the top, and its crown needs the room instead.
  const hubY =
    minSin < 0
      ? Math.round(TOP_ROOM + NODE_AVATAR / 2 - ry * minSin)
      : TOP_ROOM + HUB_AVATAR / 2 + 16;
  const hub = { x: halfWidth, y: hubY };
  const slots = angles.map((angle) => ({
    x: Number((hub.x + rx * Math.cos(angle)).toFixed(1)),
    y: Number((hub.y + ry * Math.sin(angle)).toFixed(1)),
  }));
  const lowest = Math.max(
    hub.y + HUB_AVATAR / 2 + NAME_LINE_HEIGHT + CAPTION_HEIGHT + 4,
    ...slots.map(
      (slot) =>
        slot.y + NODE_AVATAR / 2 + AVATAR_GAP + NAME_LINE_HEIGHT * NAME_LINES + CAPTION_HEIGHT,
    ),
  );
  return {
    width: skyWidth,
    height: Math.ceil(lowest + BOTTOM_ROOM + (slots.length === 0 ? TOP_ROOM : 0)),
    hub,
    slots,
    rx,
    ry,
    hidden,
  };
}

/**
 * How many pairs of plates touch: 0 is a clean card. Pass the roster's own
 * label sizes ({@link memberLabelSizes}) to check a real team - including the
 * wide "Release Notes Copywriter" - or nothing for the widest labels the
 * columns allow; `{0, 0}` checks the avatars alone. The layout is the design's
 * own, so this is the test that says "9 bots fit", not a search at runtime.
 */
export function teamLayoutOverlaps(
  layout: ConstellationLayout,
  sizes: {
    /** One size for every member, or one per slot in member order. */
    readonly member?: LabelSizes | ReadonlyArray<LabelSizes>;
    readonly lead?: LabelSizes;
  } = {},
): number {
  const hub = hubBoxes(layout.hub.x, layout.hub.y, sizes.lead ?? WORST_LEAD_LABEL);
  const memberSizes = sizes.member;
  const placed = layout.slots.map((slot, index) =>
    nodeBoxes(
      slot.x,
      slot.y,
      Array.isArray(memberSizes)
        ? (memberSizes[index] ?? WORST_MEMBER_LABEL)
        : (memberSizes ?? WORST_MEMBER_LABEL),
    ),
  );
  let clashes = 0;
  for (const [index, boxes] of placed.entries()) {
    if (boxesCollide(boxes, hub)) clashes += 1;
    for (let other = 0; other < index; other += 1) {
      if (boxesCollide(boxes, placed[other]!)) clashes += 1;
    }
  }
  // A node that leaves the card is a clash with the card's own edge.
  for (const boxes of placed) {
    if (boxes.some((entry) => entry.x0 < 0 || entry.x1 > layout.width)) clashes += 1;
  }
  return clashes;
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
