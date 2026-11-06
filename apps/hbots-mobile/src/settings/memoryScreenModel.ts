import type { PersonalMemoryEntry } from "@t3tools/contracts";

export interface MemoryTotals {
  readonly rules: number;
  readonly notes: number;
  readonly summaries: number;
}

/** The one line the list shows when nothing can be rendered. */
export function memoryEmptyLine(input: {
  readonly search: string;
  readonly visible: number;
  readonly totals: MemoryTotals;
}): string | null {
  if (input.visible > 0) return null;
  if (input.search.trim().length > 0) return "No memory matches that search.";
  const all = input.totals.rules + input.totals.notes + input.totals.summaries;
  return all === 0 ? 'Nothing saved yet. Ask a bot to "remember" something.' : null;
}

export interface MemorySectionInput {
  readonly title: string;
  readonly hint: string;
  readonly entries: ReadonlyArray<PersonalMemoryEntry>;
  readonly total: number | undefined;
}

export interface MemorySectionModel extends MemorySectionInput {
  readonly showMore: boolean;
  readonly heading: string;
}

/** The three current lists, with their heading totals and Show more state. */
export function memorySections(input: {
  readonly rules: ReadonlyArray<PersonalMemoryEntry>;
  readonly ruleTotal: number | undefined;
  readonly notes: ReadonlyArray<PersonalMemoryEntry>;
  readonly noteTotal: number | undefined;
  readonly summaries: ReadonlyArray<PersonalMemoryEntry>;
  readonly summaryTotal: number | undefined;
}): ReadonlyArray<MemorySectionModel> {
  const section = (
    title: string,
    hint: string,
    entries: ReadonlyArray<PersonalMemoryEntry>,
    total: number | undefined,
  ): MemorySectionModel => ({
    title,
    hint,
    entries,
    total,
    showMore: entries.length < (total ?? 0),
    heading: total === undefined ? title : `${title} · ${total}`,
  });
  return [
    section(
      "Rules",
      "Standing instructions. Every rule is listed here.",
      input.rules,
      input.ruleTotal,
    ),
    section("Notes", "Facts, decisions and events bots saved.", input.notes, input.noteTotal),
    section(
      "Task summaries",
      "Short summaries of finished tasks.",
      input.summaries,
      input.summaryTotal,
    ),
  ];
}
