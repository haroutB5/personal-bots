import type { ComputerSource } from "./computerContract";

/** Which source the live view shows, and whether it follows the bot. */
export interface SourcePrefs {
  readonly auto: boolean;
  readonly pinned: ComputerSource;
}

export const DEFAULT_SOURCE_PREFS: SourcePrefs = { auto: true, pinned: "browser" };

export const SOURCE_PREFS_KEY = "hbots.computer.source";

/** Auto never moves the view within this long of the user's own tap. */
export const AUTO_TAP_GRACE_MS = 3000;

export function parseSourcePrefs(raw: string | null): SourcePrefs {
  if (raw === null) return DEFAULT_SOURCE_PREFS;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_SOURCE_PREFS;
    const record = value as Record<string, unknown>;
    return {
      auto: typeof record.auto === "boolean" ? record.auto : true,
      pinned: record.pinned === "desktop" ? "desktop" : "browser",
    };
  } catch {
    return DEFAULT_SOURCE_PREFS;
  }
}

export function loadSourcePrefs(storage: Pick<Storage, "getItem"> | null): SourcePrefs {
  try {
    return parseSourcePrefs(storage?.getItem(SOURCE_PREFS_KEY) ?? null);
  } catch {
    return DEFAULT_SOURCE_PREFS;
  }
}

export function saveSourcePrefs(storage: Pick<Storage, "setItem"> | null, prefs: SourcePrefs) {
  try {
    storage?.setItem(SOURCE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or a full quota: the choice just does not persist.
  }
}

export interface BotAction {
  readonly source: ComputerSource;
  /** Epoch ms of the action. */
  readonly at: number;
}

export interface ResolveSourceInput {
  readonly prefs: SourcePrefs;
  /** What is on screen now. */
  readonly current: ComputerSource;
  /** A help request or sensitive pause is open (always the browser today). */
  readonly helpOpen: boolean;
  /** The source you are in control of, if any. */
  readonly controlSource: ComputerSource | null;
  readonly lastBotAction: BotAction | null;
  /** Epoch ms of your last tap on a segment. */
  readonly lastTapAt: number | null;
  readonly now: number;
  readonly desktopAvailable: boolean;
}

/**
 * The source the stage shows. Pinned (Auto off): the pin. Auto on: while you
 * are in control that source, never moved from under you; else an open help or
 * sensitive ask; else, outside the 3 s after your own tap, the source of the
 * newest bot action; else wherever it already is.
 */
export function resolveSource(input: ResolveSourceInput): ComputerSource {
  const clamp = (source: ComputerSource): ComputerSource =>
    source === "desktop" && !input.desktopAvailable ? "browser" : source;
  if (!input.prefs.auto) return clamp(input.prefs.pinned);
  if (input.controlSource !== null) return clamp(input.controlSource);
  if (input.helpOpen) return "browser";
  if (input.lastTapAt !== null && input.now - input.lastTapAt < AUTO_TAP_GRACE_MS) {
    return clamp(input.current);
  }
  if (input.lastBotAction !== null) return clamp(input.lastBotAction.source);
  return clamp(input.current);
}

/** Copy for the "followed" toast, or null when nothing moved. */
export function followedToast(
  from: ComputerSource,
  to: ComputerSource,
  botName: string | null,
): string | null {
  if (from === to) return null;
  const who = botName ?? "the bot";
  return `Followed ${who} to the ${to === "desktop" ? "desktop" : "browser"}`;
}
