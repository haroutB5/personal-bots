import {
  botTeam,
  isTeamLead,
  PERSONAL_BOT_TEAM_LABELS,
  PERSONAL_BOT_TEAM_ORDER,
  PERSONAL_TASK_TERMINAL_STATUSES,
  type PersonalBotTeam,
  type PersonalTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface TeamDiagramPoint {
  readonly x: number;
  readonly y: number;
}

export interface TeamBotPosition extends TeamDiagramPoint {
  readonly row: number;
  readonly column: number;
}

/** One team as the diagram draws it: its lead, then everyone else. */
export interface TeamGroup {
  readonly team: PersonalBotTeam;
  readonly label: string;
  readonly leadBotId: string | null;
  readonly memberBotIds: ReadonlyArray<string>;
}

export interface TeamGroupsLayoutOptions {
  readonly width: number;
  /** Leads are drawn larger than their members. */
  readonly leadSize: number;
  readonly nodeSize: number;
  readonly gapX: number;
  readonly gapY: number;
  /** Space under the owner and between the two teams. */
  readonly bandGap: number;
  /** Room for a team's heading above its lead. */
  readonly headingSpace: number;
  readonly perRow: number;
}

/** The vertical slice of the diagram one team occupies, heading included. */
export interface TeamGroupBand {
  readonly team: PersonalBotTeam;
  readonly label: string;
  readonly labelY: number;
  readonly leadBotId: string | null;
  readonly top: number;
  readonly bottom: number;
}

export interface TeamGroupsLayout {
  readonly owner: TeamDiagramPoint;
  readonly bots: ReadonlyMap<string, TeamBotPosition>;
  readonly bands: ReadonlyArray<TeamGroupBand>;
  readonly svgHeight: number;
}

export type DelegationLinkState = "running" | "recent";

export interface DelegationLink {
  readonly from: string;
  readonly to: string;
  readonly state: DelegationLinkState;
}

export const RECENT_DELEGATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

const LABEL_SPACE = 48;

/**
 * Groups the bots into their two teams, dev first, each with its lead pulled
 * out in front of the rest. A team nobody is on is not drawn at all.
 */
export function buildTeamGroups(
  bots: ReadonlyArray<{
    readonly botId: string;
    readonly team?: PersonalBotTeam;
    readonly lead?: boolean;
  }>,
): TeamGroup[] {
  return PERSONAL_BOT_TEAM_ORDER.flatMap((team) => {
    const members = bots.filter((bot) => botTeam(bot) === team);
    if (members.length === 0) return [];
    const lead = members.find(isTeamLead) ?? null;
    return [
      {
        team,
        label: PERSONAL_BOT_TEAM_LABELS[team],
        leadBotId: lead?.botId ?? null,
        memberBotIds: members.filter((bot) => bot.botId !== lead?.botId).map((bot) => bot.botId),
      },
    ];
  });
}

/**
 * Stacks the teams under the owner: a heading, the lead centred below it, then
 * that team's members in centred, wrapped rows. Bands never overlap, so the
 * two teams read as two separate groups on a phone-width diagram.
 */
export function buildTeamGroupsLayout(
  groups: ReadonlyArray<TeamGroup>,
  options: TeamGroupsLayoutOptions,
): TeamGroupsLayout {
  const leadSize = Math.max(1, options.leadSize);
  const nodeSize = Math.max(1, options.nodeSize);
  const width = Math.max(leadSize, nodeSize, options.width);
  const gapX = Math.max(0, options.gapX);
  const gapY = Math.max(0, options.gapY);
  const bandGap = Math.max(0, options.bandGap);
  const headingSpace = Math.max(0, options.headingSpace);
  const perRow = Math.min(
    Math.max(1, Math.floor(options.perRow)),
    Math.max(1, Math.floor((width + gapX) / (nodeSize + gapX))),
  );

  const owner: TeamDiagramPoint = { x: width / 2, y: leadSize / 2 };
  const bots = new Map<string, TeamBotPosition>();
  const bands: TeamGroupBand[] = [];
  let top = owner.y + leadSize / 2 + bandGap;

  for (const group of groups) {
    const labelY = top;
    let cursor = top + headingSpace;
    let rowIndex = 0;
    if (group.leadBotId !== null) {
      bots.set(group.leadBotId, {
        x: width / 2,
        y: cursor + leadSize / 2,
        row: rowIndex,
        column: 0,
      });
      cursor += leadSize + gapY;
      rowIndex += 1;
    }
    // Without a lead the band starts straight at its first member row.
    let lastRowBottom = group.leadBotId === null ? cursor : cursor - gapY;
    for (let offset = 0; offset < group.memberBotIds.length; offset += perRow) {
      const row = group.memberBotIds.slice(offset, offset + perRow);
      const rowWidth = row.length * nodeSize + Math.max(0, row.length - 1) * gapX;
      const firstCenterX = (width - rowWidth) / 2 + nodeSize / 2;
      const y = cursor + nodeSize / 2;
      row.forEach((botId, column) => {
        bots.set(botId, {
          x: firstCenterX + column * (nodeSize + gapX),
          y,
          row: rowIndex,
          column,
        });
      });
      rowIndex += 1;
      cursor += nodeSize + gapY;
      lastRowBottom = cursor - gapY;
    }
    // LABEL_SPACE is the name and title printed under the lowest row.
    const bottom = lastRowBottom + LABEL_SPACE;
    bands.push({
      team: group.team,
      label: group.label,
      labelY,
      leadBotId: group.leadBotId,
      top,
      bottom,
    });
    top = bottom + bandGap;
  }

  return {
    owner,
    bots,
    bands,
    svgHeight: bands.at(-1)?.bottom ?? owner.y + leadSize / 2 + LABEL_SPACE,
  };
}

/**
 * Turns task parent/child relationships into directed bot links. An unfinished
 * child wins over recent history for the same pair.
 */
export function deriveDelegationLinks(
  tasks: ReadonlyArray<PersonalTask>,
  botIds: ReadonlySet<string>,
  nowMs: number,
): DelegationLink[] {
  const tasksById = new Map(tasks.map((task) => [task.taskId as string, task] as const));
  const links = new Map<string, DelegationLink>();
  const recentCutoff = nowMs - RECENT_DELEGATION_WINDOW_MS;

  for (const child of tasks) {
    if (child.parentTaskId === null) continue;
    const parent = tasksById.get(child.parentTaskId as string);
    if (parent === undefined) continue;
    const from = parent.botId as string;
    const to = child.botId as string;
    if (from === to || !botIds.has(from) || !botIds.has(to)) continue;

    const terminal = PERSONAL_TASK_TERMINAL_STATUSES.includes(child.status);
    const completedMs = DateTime.toEpochMillis(child.completedAt ?? child.updatedAt);
    const state: DelegationLinkState | null = terminal
      ? completedMs >= recentCutoff
        ? "recent"
        : null
      : "running";
    if (state === null) continue;

    const key = `${from}\u0000${to}`;
    const previous = links.get(key);
    if (previous === undefined || (previous.state === "recent" && state === "running")) {
      links.set(key, { from, to, state });
    }
  }

  return [...links.values()].toSorted(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

const pathNumber = (value: number) => Number(value.toFixed(2));

/** Curved edge-to-edge path for a directional link between two bot nodes. */
export function delegationConnectorPath(
  from: TeamDiagramPoint,
  to: TeamDiagramPoint,
  nodeSize: number,
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return "";

  const unitX = dx / distance;
  const unitY = dy / distance;
  // Two things made this edge invisible on a phone. Adjacent columns are only
  // `nodeSize + gapX` — 96 units — apart, so insetting along the straight
  // centre line spent nodeSize + 14 of that span and left an 18-unit stub; and
  // each node's label column is an opaque `w-24` box spanning `nodeSize + gapX`
  // horizontally from `y - nodeSize / 2` down, so neighbouring boxes tile with
  // no seam and hide anything drawn at or below the avatars.
  //
  // So: bow the edge *away from the labels* (toward the top of the diagram,
  // into the clear band under the owner) and leave each node radially through
  // the control point rather than along the centre line. The endpoints stay one
  // silhouette clear of their own node while the visible span grows with the
  // bow.
  const bend = Math.max(nodeSize * 1.1, distance * 0.18);
  const normalX = -unitY;
  const normalY = unitX;
  const orient = normalY > 0 ? -1 : 1;
  const control = {
    x: (from.x + to.x) / 2 + normalX * bend * orient,
    y: (from.y + to.y) / 2 + normalY * bend * orient,
  };
  // Both radii are `hypot(distance / 2, bend)`; the 0.6 cap keeps the two
  // endpoints from crossing when nodes are large relative to their spacing.
  const reach = Math.hypot(distance / 2, bend);
  const startInset = Math.min(nodeSize / 2 + 4, reach * 0.6);
  const endInset = Math.min(nodeSize / 2 + 10, reach * 0.6);
  const start = {
    x: from.x + ((control.x - from.x) / reach) * startInset,
    y: from.y + ((control.y - from.y) / reach) * startInset,
  };
  const end = {
    x: to.x + ((control.x - to.x) / reach) * endInset,
    y: to.y + ((control.y - to.y) / reach) * endInset,
  };

  return `M ${pathNumber(start.x)} ${pathNumber(start.y)} Q ${pathNumber(control.x)} ${pathNumber(control.y)} ${pathNumber(end.x)} ${pathNumber(end.y)}`;
}

/** The whole diagram as one sentence, for the SVG's accessible name. */
export function teamDiagramSummary(
  ownerName: string,
  groups: ReadonlyArray<TeamGroup>,
  bots: ReadonlyArray<{ readonly botId: string; readonly name: string }>,
  links: ReadonlyArray<DelegationLink>,
): string {
  const owner = ownerName.trim() || "You";
  const names = new Map(bots.map((bot) => [bot.botId, bot.name] as const));
  const nameOf = (botId: string) => names.get(botId) ?? "a deleted bot";
  const teams = groups.map((group) => {
    const lead = group.leadBotId === null ? "no lead" : `led by ${nameOf(group.leadBotId)}`;
    const members =
      group.memberBotIds.length === 0
        ? "no other members"
        : `with ${group.memberBotIds.map(nameOf).join(", ")}`;
    return `${group.label}, ${lead}, ${members}`;
  });
  const delegations = links.flatMap((link) => {
    const from = names.get(link.from);
    const to = names.get(link.to);
    return from === undefined || to === undefined ? [] : [`${from} delegating to ${to}`];
  });
  return `${owner}'s bots. ${teams.join(". ")}. ${
    delegations.length === 0 ? "No current or recent delegations" : delegations.join("; ")
  }.`;
}
