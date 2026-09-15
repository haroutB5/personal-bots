import type { UsageCard, UsageCardDriver } from "./usagePresentation";

/**
 * One half of the Chats-screen usage strip. `sessionPercent` is the 5-hour
 * window, `weeklyPercent` the first weekly window (the all-models one the
 * server lists first). Either is null when the provider reports nothing —
 * the strip shows a dash there, never a misleading 0%.
 */
export interface UsageStripCell {
  readonly driver: UsageCardDriver;
  readonly title: string;
  readonly sessionPercent: number | null;
  readonly weeklyPercent: number | null;
}

/**
 * Cells for the strip, in card order (Claude left, Codex right). Cards that
 * cannot report (`unavailable` / `not-reported`) keep their cell so the
 * provider name stays visible; their figures are null.
 */
export function selectUsageStripCells(cards: ReadonlyArray<UsageCard>): readonly UsageStripCell[] {
  return cards.map((card) => ({
    driver: card.driver,
    title: card.title,
    sessionPercent: card.status === "ready" ? (card.session?.usedPercent ?? null) : null,
    weeklyPercent: card.status === "ready" ? (card.weeklies[0]?.usedPercent ?? null) : null,
  }));
}

/** "26%" for a figure the provider reported, an en dash for one it did not. */
export function formatStripPercent(percent: number | null): string {
  return percent === null ? "–" : `${percent}%`;
}

/**
 * Full sentence for the strip button: the bars are decorative, so every
 * number a sighted user can read has to live in this label.
 */
export function usageStripAriaLabel(cells: ReadonlyArray<UsageStripCell>): string {
  const parts = cells.map((cell) => {
    const session =
      cell.sessionPercent === null
        ? "Session not reported"
        : `Session ${cell.sessionPercent} percent used`;
    const weekly =
      cell.weeklyPercent === null
        ? "Weekly not reported"
        : `Weekly ${cell.weeklyPercent} percent used`;
    return `${cell.title}, ${session}, ${weekly}`;
  });
  return `Usage: ${parts.join("; ")}. Open details.`;
}
