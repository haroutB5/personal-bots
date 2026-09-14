import { PERSONAL_TASK_TERMINAL_STATUSES, type PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface TeamDiagramPoint {
  readonly x: number;
  readonly y: number;
}

export interface TeamBotPosition extends TeamDiagramPoint {
  readonly row: number;
  readonly column: number;
}

export interface TeamLayoutOptions {
  readonly width: number;
  readonly nodeSize: number;
  readonly gapX: number;
  readonly gapY: number;
  readonly perRow: number;
}

export interface TeamLayout {
  readonly owner: TeamDiagramPoint;
  readonly bots: ReadonlyMap<string, TeamBotPosition>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
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

/** Centers the owner and each wrapped bot row in a fixed-width diagram. */
export function buildTeamLayout(
  botIds: ReadonlyArray<string>,
  options: TeamLayoutOptions,
): TeamLayout {
  const nodeSize = Math.max(1, options.nodeSize);
  const width = Math.max(nodeSize, options.width);
  const gapX = Math.max(0, options.gapX);
  const gapY = Math.max(0, options.gapY);
  const desiredPerRow = Math.max(1, Math.floor(options.perRow));
  const fittingPerRow = Math.max(1, Math.floor((width + gapX) / (nodeSize + gapX)));
  const perRow = Math.min(desiredPerRow, fittingPerRow);
  const owner = { x: width / 2, y: nodeSize / 2 };
  const rows: string[][] = [];
  const bots = new Map<string, TeamBotPosition>();

  for (let offset = 0; offset < botIds.length; offset += perRow) {
    const row = botIds.slice(offset, offset + perRow);
    const rowIndex = rows.length;
    const rowWidth = row.length * nodeSize + Math.max(0, row.length - 1) * gapX;
    const firstCenterX = (width - rowWidth) / 2 + nodeSize / 2;
    const y = owner.y + nodeSize + gapY + rowIndex * (nodeSize + gapY);
    rows.push(row);
    row.forEach((botId, column) => {
      bots.set(botId, {
        x: firstCenterX + column * (nodeSize + gapX),
        y,
        row: rowIndex,
        column,
      });
    });
  }

  const lastBotY =
    rows.length === 0 ? owner.y : owner.y + nodeSize + gapY + (rows.length - 1) * (nodeSize + gapY);
  return {
    owner,
    bots,
    rows,
    svgHeight: lastBotY + nodeSize / 2 + LABEL_SPACE,
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

export function teamDiagramSummary(
  ownerName: string,
  bots: ReadonlyArray<{ readonly botId: string; readonly name: string }>,
  links: ReadonlyArray<DelegationLink>,
): string {
  const owner = ownerName.trim() || "You";
  const botCount = `${bots.length} ${bots.length === 1 ? "bot" : "bots"}`;
  const names = new Map(bots.map((bot) => [bot.botId, bot.name] as const));
  const delegations = links.flatMap((link) => {
    const from = names.get(link.from);
    const to = names.get(link.to);
    return from === undefined || to === undefined ? [] : [`${from} delegating to ${to}`];
  });
  return `${owner} and ${botCount}; ${delegations.length === 0 ? "no current or recent delegations" : delegations.join("; ")}.`;
}
