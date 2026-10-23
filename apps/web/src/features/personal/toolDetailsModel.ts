import { workEntryDisplayLabel } from "~/components/chat/MessagesTimeline.logic";
import type { WorkLogEntry } from "~/session-logic";

type WorkFamily = "command" | "read" | "edit" | "browse" | "other";

/**
 * The compact summary one batch of tool work shows while collapsed: the
 * work-log style Harout approved on 23 Oct (mockup: hbots-working-steps-mockup).
 * A single family reads as an action ("Ran 3 commands"); mixed work keeps the
 * neutral step count. Failures always ride the line, so a collapsed batch never
 * hides one.
 */
export interface ToolDetailsSummary {
  /** Settled summary, e.g. "Ran 3 commands · 1 failed". */
  readonly label: string;
  /** While live: the current action, e.g. "Ran vp test run". */
  readonly liveLabel: string | null;
  readonly failures: number;
  readonly count: number;
}

function familyOf(entry: WorkLogEntry): WorkFamily {
  if (entry.command !== undefined || entry.rawCommand !== undefined) return "command";
  if ((entry.changedFiles?.length ?? 0) > 0) return "edit";
  if (entry.requestKind === "file-read") return "read";
  if (entry.toolSurface === "browser") return "browse";
  const label = entry.label.trim().toLowerCase();
  if (label.startsWith("read ")) return "read";
  if (label.startsWith("ran ") || label.startsWith("running ")) return "command";
  if (label.startsWith("edited ") || label.startsWith("wrote ")) return "edit";
  if (
    label.startsWith("browsed ") ||
    label.startsWith("navigated ") ||
    label.startsWith("screenshot")
  ) {
    return "browse";
  }
  return "other";
}

function familyLabel(family: WorkFamily, count: number): string {
  const plural = count === 1 ? "" : "s";
  switch (family) {
    case "command":
      return `Ran ${count} command${plural}`;
    case "read":
      return `Read ${count} file${plural}`;
    case "edit":
      return `Edited ${count} file${plural}`;
    case "browse":
      return `Browsed ${count} page${plural}`;
    case "other":
      return `${count} step${plural}`;
  }
}

export function toolDetailsSummary(
  entries: ReadonlyArray<WorkLogEntry>,
  live: boolean,
  workspaceRoot: string | undefined,
): ToolDetailsSummary {
  const failures = entries.filter((entry) => entry.tone === "error").length;
  const count = entries.length;
  const families = new Set(entries.map(familyOf));
  const base =
    count === 0
      ? "Working…"
      : families.size === 1
        ? familyLabel([...families][0]!, count)
        : `${count} step${count === 1 ? "" : "s"}`;
  const label = failures > 0 ? `${base} · ${failures} failed` : base;
  const last = entries.at(-1);
  return {
    label,
    liveLabel: live && last !== undefined ? workEntryDisplayLabel(last, workspaceRoot) : null,
    failures,
    count,
  };
}
