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

/**
 * What the cell's one bar fills to: the window that is further spent, and so
 * the one that will actually stop him working. A weekly allowance at 100% with
 * an idle session window used to render as an empty bar beside the words
 * "Weekly 100% used" — the bar claimed he had everything left.
 *
 * Null only when neither window was reported. A reported 0% still fills to 0,
 * which is honest; null is the strip's "nothing to say".
 */
export function stripCellBarPercent(cell: UsageStripCell): number | null {
  const reported = [cell.sessionPercent, cell.weeklyPercent].filter(
    (percent): percent is number => percent !== null,
  );
  return reported.length === 0 ? null : Math.max(...reported);
}

/** Percent at which a window is close enough to spent to be worth colouring. */
export const STRIP_BINDING_THRESHOLD = 80;

/**
 * Which window is the one about to stop a bot, once either is near spent.
 *
 * The bar fills to the worse of the two, which answers "how much headroom is
 * left" but not "which limit is it" - and those differ a lot: a spent 5-hour
 * window clears in hours, a spent week may not clear for days. Naming the
 * binding window in the text costs no vertical space. A tie goes to weekly,
 * the one that takes longer to come back.
 */
export function stripBindingWindow(cell: UsageStripCell): "session" | "weekly" | null {
  const session = cell.sessionPercent;
  const weekly = cell.weeklyPercent;
  const worst = stripCellBarPercent(cell);
  if (worst === null || worst < STRIP_BINDING_THRESHOLD) return null;
  if (weekly !== null && weekly === worst) return "weekly";
  return session !== null && session === worst ? "session" : null;
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
