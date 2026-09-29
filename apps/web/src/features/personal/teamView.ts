/**
 * What the Team screen looked like when its owner left it for a bot, a chat, an
 * edit form or a task: how far it was scrolled and which members list was open.
 * It rides in the history state of the Team entry (and is copied onto the
 * entries opened from it), so Back, a reload and the relaunch after iOS ends the
 * app all put the screen back as it was.
 */
export interface TeamView {
  readonly scrollTop: number;
  /** The team card at the top of the screen, and how far it is scrolled past. */
  readonly anchorTeam: string | null;
  readonly anchorOffset: number;
  /** The team whose members list ("N bots >") was open, if any. */
  readonly membersTeam: string | null;
}

export const EMPTY_TEAM_VIEW: TeamView = {
  scrollTop: 0,
  anchorTeam: null,
  anchorOffset: 0,
  membersTeam: null,
};

export function parseTeamView(value: unknown): TeamView | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const number = (input: unknown) =>
    typeof input === "number" && Number.isFinite(input) ? input : 0;
  const text = (input: unknown) => (typeof input === "string" && input !== "" ? input : null);
  return {
    scrollTop: Math.max(0, number(raw.scrollTop)),
    anchorTeam: text(raw.anchorTeam),
    anchorOffset: number(raw.anchorOffset),
    membersTeam: text(raw.membersTeam),
  };
}

let source: (() => TeamView) | null = null;

/** The mounted Team screen offers a way to read its view; the last one wins. */
export function registerTeamViewSource(read: () => TeamView): () => void {
  source = read;
  return () => {
    if (source === read) source = null;
  };
}

/** The Team screen's view right now, or null when it is not on screen. */
export function captureTeamView(): TeamView | null {
  try {
    return source?.() ?? null;
  } catch {
    return null;
  }
}
