import {
  botTeam,
  isTeamLead,
  personalBotTeamLabel,
  personalBotTeams,
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
 * Groups bots under their leads. Registered custom teams remain available
 * as drop targets when empty.
 */
export function buildTeamGroups(
  bots: ReadonlyArray<{
    readonly botId: string;
    readonly team?: PersonalBotTeam;
    readonly lead?: boolean;
  }>,
  customTeams: ReadonlyArray<PersonalBotTeam> = [],
): TeamGroup[] {
  return personalBotTeams([...customTeams, ...bots.map(botTeam)]).flatMap((team) => {
    const members = bots.filter((bot) => botTeam(bot) === team);
    if (members.length === 0 && !customTeams.includes(team)) return [];
    const lead = members.find(isTeamLead) ?? null;
    return [
      {
        team,
        label: personalBotTeamLabel(team),
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

/**
 * An elbowed polyline with rounded corners. Every connector that is meant to
 * read as "reports to" is drawn this way, so a line only ever leaves a node
 * sideways into a lane and arrives at a node from directly above it. A
 * straight line between two centres cannot say that on a phone-width diagram:
 * it passes across whatever happens to sit between them, which is how the
 * owner's line to the assistant's lead used to look like Security reporting
 * down into the other team.
 */
export function orthogonalPath(points: ReadonlyArray<TeamDiagramPoint>, radius: number): string {
  const corners: TeamDiagramPoint[] = [];
  for (const point of points) {
    const previous = corners.at(-1);
    if (previous !== undefined && previous.x === point.x && previous.y === point.y) continue;
    corners.push(point);
  }
  const first = corners[0];
  if (first === undefined || corners.length < 2) return "";

  const parts = [`M ${pathNumber(first.x)} ${pathNumber(first.y)}`];
  for (let index = 1; index < corners.length - 1; index += 1) {
    const previous = corners[index - 1]!;
    const corner = corners[index]!;
    const next = corners[index + 1]!;
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const bend = Math.min(radius, inLength / 2, outLength / 2);
    const enter = {
      x: corner.x + ((previous.x - corner.x) / inLength) * bend,
      y: corner.y + ((previous.y - corner.y) / inLength) * bend,
    };
    const leave = {
      x: corner.x + ((next.x - corner.x) / outLength) * bend,
      y: corner.y + ((next.y - corner.y) / outLength) * bend,
    };
    parts.push(
      `L ${pathNumber(enter.x)} ${pathNumber(enter.y)}`,
      `Q ${pathNumber(corner.x)} ${pathNumber(corner.y)} ${pathNumber(leave.x)} ${pathNumber(leave.y)}`,
    );
  }
  const last = corners.at(-1)!;
  parts.push(`L ${pathNumber(last.x)} ${pathNumber(last.y)}`);
  return parts.join(" ");
}

export interface TeamConnectorOptions {
  readonly width: number;
  readonly leadSize: number;
  readonly nodeSize: number;
  /** Width of a node's opaque name column; lanes stay outside it. */
  readonly labelWidth: number;
}

export type TeamConnectorKind = "owner" | "member";

export interface TeamConnector {
  readonly key: string;
  readonly kind: TeamConnectorKind;
  readonly d: string;
  /** Only a connector that ends on a node carries the arrow head. */
  readonly arrow: boolean;
}

/** Where the two vertical lanes run, plus the two mirrored lanes on the right. */
export interface TeamConnectorLanes {
  readonly owner: number;
  readonly member: number;
  /** Outer right lane: a handoff across the two teams. */
  readonly cross: number;
  /** Inner right lane: a handoff between two rows of the same team. */
  readonly delegation: number;
}

const CORNER_RADIUS = 10;

/**
 * The two left-hand lanes. Both sit clear of every node's name column, so a
 * vertical run never passes behind a name and never lines two members up as if
 * one fed the other.
 */
export function teamConnectorLanes(
  layout: TeamGroupsLayout,
  options: TeamConnectorOptions,
): TeamConnectorLanes {
  const half = Math.max(1, options.labelWidth) / 2;
  const leftmost = [layout.owner, ...layout.bots.values()].reduce(
    (min, position) => Math.min(min, position.x - half),
    options.width,
  );
  const member = Math.max(8, Math.min(26, leftmost - 10));
  const owner = Math.max(3, member - 13);
  // Rows are centred, so the right-hand mirror of a left lane clears the
  // right-most name column by exactly as much as the original clears the
  // left-most one.
  return { owner, member, cross: options.width - owner, delegation: options.width - member };
}

/**
 * Every "reports to" line in the diagram: the owner reaching each team's lead
 * down the outer lane, and each lead reaching its own members down that team's
 * own lane and along one bus per row. Nothing is drawn between two members, and
 * no line crosses a band it does not belong to.
 */
export function buildTeamConnectors(
  groups: ReadonlyArray<TeamGroup>,
  layout: TeamGroupsLayout,
  options: TeamConnectorOptions,
): TeamConnector[] {
  const lanes = teamConnectorLanes(layout, options);
  const leadRadius = options.leadSize / 2;
  const nodeRadius = options.nodeSize / 2;
  const connectors: TeamConnector[] = [];

  for (const group of groups) {
    const lead = group.leadBotId === null ? undefined : layout.bots.get(group.leadBotId);
    // Each row of members gets its own bus, fed from the band's own lane.
    const rows = new Map<number, TeamBotPosition[]>();
    for (const botId of group.memberBotIds) {
      const position = layout.bots.get(botId);
      if (position === undefined) continue;
      const row = rows.get(position.row) ?? [];
      row.push(position);
      rows.set(position.row, row);
    }
    const busOf = (row: ReadonlyArray<TeamBotPosition>) => row[0]!.y - nodeRadius - 14;

    if (lead !== undefined) {
      connectors.push({
        key: `owner:${group.team}`,
        kind: "owner",
        arrow: true,
        d: orthogonalPath(
          [
            { x: layout.owner.x - leadRadius - 4, y: layout.owner.y },
            { x: lanes.owner, y: layout.owner.y },
            { x: lanes.owner, y: lead.y },
            { x: lead.x - leadRadius - 10, y: lead.y },
          ],
          CORNER_RADIUS,
        ),
      });
    }

    const sortedRows = [...rows.entries()].toSorted(([left], [right]) => left - right);
    const lowestBus = sortedRows.at(-1);
    if (lowestBus === undefined) continue;

    // The trunk: out of the lead (or the owner, for a team with no lead) into
    // this band's lane, down to the last row's bus.
    const trunkFrom =
      lead === undefined
        ? { x: layout.owner.x - leadRadius - 4, y: layout.owner.y }
        : { x: lead.x - leadRadius - 4, y: lead.y };
    connectors.push({
      key: `trunk:${group.team}`,
      kind: "member",
      arrow: false,
      d: orthogonalPath(
        [
          trunkFrom,
          { x: lanes.member, y: trunkFrom.y },
          { x: lanes.member, y: busOf(lowestBus[1]) },
        ],
        CORNER_RADIUS,
      ),
    });

    for (const [row, positions] of sortedRows) {
      const busY = busOf(positions);
      const furthest = positions.reduce((max, position) => Math.max(max, position.x), lanes.member);
      connectors.push({
        key: `bus:${group.team}:${String(row)}`,
        kind: "member",
        arrow: false,
        d: orthogonalPath(
          [
            { x: lanes.member, y: busY },
            { x: furthest, y: busY },
          ],
          CORNER_RADIUS,
        ),
      });
      for (const position of positions) {
        connectors.push({
          key: `drop:${group.team}:${String(row)}:${String(position.column)}`,
          kind: "member",
          arrow: true,
          d: orthogonalPath(
            [
              { x: position.x, y: busY },
              { x: position.x, y: position.y - nodeRadius - 8 },
            ],
            CORNER_RADIUS,
          ),
        });
      }
    }
  }

  return connectors;
}

/**
 * A handoff the owner allowed across the two teams, routed up out of its row
 * and down the right-hand lane instead of cutting through both bands. The bowed
 * {@link delegationConnectorPath} is right for two bots standing side by side;
 * over the height of the whole diagram it reads as a reporting line.
 *
 * Both ends leave and arrive from directly above their node, never sideways:
 * a sideways exit at avatar height runs straight through whichever team-mates
 * share the row, which is the same false reporting line in a different colour.
 */
export function crossTeamDelegationPath(
  from: TeamDiagramPoint,
  to: TeamDiagramPoint,
  options: { readonly lane: number; readonly nodeSize: number },
): string {
  return laneDelegationPath(from, to, {
    lane: options.lane,
    fromSize: options.nodeSize,
    toSize: options.nodeSize,
  });
}

/**
 * The same routing for a handoff between two rows of one team: up out of the
 * row, along a lane, and down onto the target from directly above it. The bowed
 * {@link delegationConnectorPath} only works for two bots standing side by side;
 * between rows it sags across the row below and through whatever node sits in
 * that column, which is the grey noise the diagram had.
 *
 * Leads are drawn a size up, so each end is cleared by its own silhouette
 * rather than by one shared node size.
 */
export function laneDelegationPath(
  from: TeamDiagramPoint,
  to: TeamDiagramPoint,
  options: {
    readonly lane: number;
    readonly fromSize: number;
    readonly toSize: number;
  },
): string {
  // Clear of the node, and clear of the row's own bus 14 above it.
  const corridor = (point: TeamDiagramPoint, size: number) => point.y - size / 2 - 26;
  return orthogonalPath(
    [
      { x: from.x, y: from.y - options.fromSize / 2 - 6 },
      { x: from.x, y: corridor(from, options.fromSize) },
      { x: options.lane, y: corridor(from, options.fromSize) },
      { x: options.lane, y: corridor(to, options.toSize) },
      { x: to.x, y: corridor(to, options.toSize) },
      { x: to.x, y: to.y - options.toSize / 2 - 8 },
    ],
    CORNER_RADIUS,
  );
}

/**
 * Curved edge-to-edge path for a directional link between two bot nodes of the
 * same row. Anything further apart than that goes down a lane instead; see
 * {@link laneDelegationPath}.
 */
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

export interface TeamDiagramRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What a drop means. `team` is "join this team as a member" (the team's band or
 * its chief's node); `lead` is "take this team's lead seat", which also moves
 * the bot to that team.
 */
export interface TeamDropTarget {
  readonly kind: "team" | "lead";
  readonly team: PersonalBotTeam;
}

export interface TeamDropZone {
  readonly id: string;
  readonly target: TeamDropTarget;
  /** What the zone says on screen while a bot is in the air. */
  readonly label: string;
  readonly rect: TeamDiagramRect;
}

export interface TeamDropZoneOptions {
  readonly width: number;
  readonly leadSize: number;
  readonly nodeSize: number;
}

/** How wide the "Make lead" pill is, and the gap it keeps from the lead node. */
const LEAD_ZONE_WIDTH = 104;
const LEAD_ZONE_GAP = 8;

/**
 * Every place a lifted bot can land, most specific first, so hit-testing can
 * take the first match: the lead pills, then the chief nodes, then the whole
 * band. Hit-testing is ordered here rather than in the component so "which team
 * does this drop mean" stays a pure question.
 */
export function buildTeamDropZones(
  layout: TeamGroupsLayout,
  options: TeamDropZoneOptions,
): TeamDropZone[] {
  const leadRadius = Math.max(1, options.leadSize) / 2;
  const leadZones: TeamDropZone[] = [];
  const chiefZones: TeamDropZone[] = [];
  const bandZones: TeamDropZone[] = [];

  for (const band of layout.bands) {
    const lead = band.leadBotId === null ? undefined : layout.bots.get(band.leadBotId);
    const teamLabel = personalBotTeamLabel(band.team);
    if (lead !== undefined) {
      const left = lead.x + leadRadius + LEAD_ZONE_GAP;
      const width = Math.min(LEAD_ZONE_WIDTH, Math.max(0, options.width - LEAD_ZONE_GAP - left));
      if (width >= 44) {
        leadZones.push({
          id: `lead:${band.team}`,
          target: { kind: "lead", team: band.team },
          label: "Make lead",
          rect: { x: left, y: lead.y - leadRadius, width, height: options.leadSize },
        });
      }
      chiefZones.push({
        id: `chief:${band.team}`,
        target: { kind: "team", team: band.team },
        label: teamLabel,
        rect: {
          x: lead.x - leadRadius,
          y: lead.y - leadRadius,
          width: options.leadSize,
          height: options.leadSize,
        },
      });
    }
    bandZones.push({
      id: `band:${band.team}`,
      target: { kind: "team", team: band.team },
      label: teamLabel,
      rect: {
        x: 0,
        y: band.top,
        width: options.width,
        height: Math.max(0, band.bottom - band.top),
      },
    });
  }

  return [...leadZones, ...chiefZones, ...bandZones];
}

export function hitTestTeamDropZone(
  zones: ReadonlyArray<TeamDropZone>,
  point: TeamDiagramPoint,
): TeamDropZone | null {
  return (
    zones.find(
      (zone) =>
        point.x >= zone.rect.x &&
        point.x <= zone.rect.x + zone.rect.width &&
        point.y >= zone.rect.y &&
        point.y <= zone.rect.y + zone.rect.height,
    ) ?? null
  );
}

/**
 * What a drop would do. `update` is exactly the `personalBots.update` patch to
 * send; `lead: true` makes the server demote the team's previous lead in the
 * same write, so the diagram can never show two Lead badges.
 */
export type TeamDropOutcome =
  | { readonly kind: "none"; readonly message: string }
  | { readonly kind: "blocked"; readonly message: string }
  | {
      readonly kind: "update";
      readonly message: string;
      readonly update: { readonly team: PersonalBotTeam; readonly lead: boolean };
    };

export interface TeamDropBot {
  readonly botId: string;
  readonly name: string;
  readonly team?: PersonalBotTeam;
  readonly lead?: boolean;
}

/**
 * A team is never left with members but no lead, so a lead can only move out
 * once somebody else has the seat. Moving the last bot off a team is fine: the
 * team simply stops being drawn.
 */
export function teamDropOutcome(
  bot: TeamDropBot,
  target: TeamDropTarget,
  roster: ReadonlyArray<TeamDropBot>,
): TeamDropOutcome {
  const from = botTeam(bot);
  const to = target.team;
  const toLabel = personalBotTeamLabel(to);
  const leaving = from !== to;

  if (leaving && isTeamLead(bot)) {
    const staying = roster.filter((other) => other.botId !== bot.botId && botTeam(other) === from);
    if (staying.length > 0) {
      return {
        kind: "blocked",
        message: `${bot.name} leads the ${personalBotTeamLabel(from)}. Make someone else the lead there first, then move ${bot.name}.`,
      };
    }
  }

  if (target.kind === "lead") {
    if (!leaving && isTeamLead(bot)) {
      return { kind: "none", message: `${bot.name} already leads the ${toLabel}.` };
    }
    return {
      kind: "update",
      message: `${bot.name} now leads the ${toLabel}.`,
      update: { team: to, lead: true },
    };
  }

  if (!leaving) {
    return {
      kind: "none",
      message: isTeamLead(bot)
        ? `${bot.name} already leads the ${toLabel}.`
        : `${bot.name} is already on the ${toLabel}.`,
    };
  }
  return {
    kind: "update",
    message: `${bot.name} moved to the ${toLabel}.`,
    update: { team: to, lead: false },
  };
}

/** What the live region says while a bot hangs over a target, or over nothing. */
export function teamDropHint(
  bot: TeamDropBot,
  zone: TeamDropZone | null,
  roster: ReadonlyArray<TeamDropBot>,
): string {
  if (zone === null) return `${bot.name} is over nothing. Let go to leave the team as it is.`;
  const outcome = teamDropOutcome(bot, zone.target, roster);
  if (outcome.kind === "update") return `Let go to make it so: ${outcome.message}`;
  return outcome.message;
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
