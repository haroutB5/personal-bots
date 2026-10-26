import type {
  PersonalBrowserActivityEvent,
  PersonalBrowserStatus,
  PersonalDesktopStatus,
} from "@t3tools/contracts";

/**
 * The Computer tab reads a few fields Backend adds in hbots 1.66.98 (see
 * design/computer-use-linux/SPEC.md section 10). They are not in
 * `@t3tools/contracts` yet, so this file is the one place that reads them,
 * defensively, from an older or newer server alike. When the contracts land,
 * delete the shapes below and read the typed fields directly.
 */

export type ComputerSource = "browser" | "desktop";

export type HelpKind = "captcha" | "code" | "login" | "sensitive" | "other";

export interface ComputerClaimant {
  readonly threadId: string;
  readonly botId: string;
  readonly botName: string;
}

export interface ComputerEgressPause extends ComputerClaimant {
  /** What the bot had open, e.g. "Chase, Gmail". */
  readonly sources: string;
  /** Where the next step would send it, e.g. "slack.com". */
  readonly destination: string;
  readonly requestedAt: string;
}

export interface FocusedWindow {
  readonly title: string;
  readonly windowClass: string;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readClaimant(value: unknown): ComputerClaimant | null {
  const record = asRecord(value);
  if (record === null) return null;
  const threadId = asString(record.threadId);
  const botName = asString(record.botName);
  if (threadId === null || botName === null) return null;
  return { threadId, botId: asString(record.botId) ?? "", botName };
}

function readClaimants(value: unknown): ReadonlyArray<ComputerClaimant> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const claimant = readClaimant(entry);
    return claimant === null ? [] : [claimant];
  });
}

/** Bots waiting for the shared browser (Backend section 10, optional). */
export function browserWaiting(
  status: PersonalBrowserStatus | null,
): ReadonlyArray<ComputerClaimant> {
  return status === null ? [] : readClaimants(asRecord(status)?.waiting);
}

/** Bots waiting for the desktop, first in line first. */
export function desktopWaiting(
  status: PersonalDesktopStatus | null,
): ReadonlyArray<ComputerClaimant> {
  return status === null ? [] : readClaimants(status.waiting);
}

const HELP_KINDS: ReadonlySet<string> = new Set(["captcha", "code", "login", "sensitive", "other"]);

export function helpKind(status: PersonalBrowserStatus | null): HelpKind | null {
  const help = status?.helpRequest;
  if (help === null || help === undefined) return null;
  const kind = asString(asRecord(help)?.kind);
  return kind !== null && HELP_KINDS.has(kind) ? (kind as HelpKind) : "other";
}

/** The site a human check or sign-in is about, when the server says. */
export function helpOrigin(status: PersonalBrowserStatus | null): string | null {
  const help = status?.helpRequest;
  if (help === null || help === undefined) return null;
  return asString(asRecord(help)?.origin);
}

/** A sensitive-site pause waiting for Allow once / Refuse, or null. */
export function egressPause(status: PersonalBrowserStatus | null): ComputerEgressPause | null {
  const raw = asRecord(status)?.egressPause;
  const record = asRecord(raw);
  if (record === null) return null;
  const claimant = readClaimant(record);
  if (claimant === null) return null;
  const sources = Array.isArray(record.sources)
    ? record.sources.filter((entry): entry is string => typeof entry === "string").join(", ")
    : (asString(record.sources) ?? "");
  return {
    ...claimant,
    sources,
    destination: asString(record.destination) ?? "another site",
    requestedAt: asString(record.requestedAt) ?? "",
  };
}

export function focusedWindow(status: PersonalDesktopStatus | null): FocusedWindow | null {
  const record = asRecord(asRecord(status)?.focusedWindow);
  if (record === null) return null;
  const title = asString(record.title);
  if (title === null) return null;
  return { title, windowClass: asString(record.class) ?? "" };
}

export function isLinuxDesktop(status: PersonalDesktopStatus | null): boolean {
  const hotkey = status?.stopHotkey ?? "";
  return hotkey.startsWith("Super") || focusedWindow(status) !== null;
}

/** The kinds a desktop action can carry (Backend section 10). */
export type ActivitySource = ComputerSource;

export interface ActivityPoint {
  readonly x: number;
  readonly y: number;
}

/** A browser activity event as the merged feed sees it, desktop kinds included. */
export interface ComputerActivityEvent {
  readonly id: string;
  readonly source: ActivitySource;
  readonly kind: string;
  readonly summary: string;
  readonly status: "succeeded" | "failed";
  readonly at: string;
  readonly threadId: string | null;
  readonly botName: string | null;
  readonly botId: string | null;
  readonly point: ActivityPoint | null;
  readonly chars: number | null;
}

export function readBrowserEvent(event: PersonalBrowserActivityEvent): ComputerActivityEvent {
  const record = asRecord(event) ?? {};
  // A desktop event may arrive on the browser stream once Backend merges them.
  const source: ActivitySource = record.source === "desktop" ? "desktop" : "browser";
  const x = typeof record.x === "number" ? record.x : null;
  const y = typeof record.y === "number" ? record.y : null;
  return {
    id: event.id,
    source,
    kind: event.kind,
    summary: event.summary,
    status: event.status,
    at: event.at,
    threadId: event.threadId,
    botName: event.botName,
    botId: asString(record.botId),
    point: x !== null && y !== null ? { x, y } : null,
    chars: typeof record.chars === "number" ? record.chars : null,
  };
}
