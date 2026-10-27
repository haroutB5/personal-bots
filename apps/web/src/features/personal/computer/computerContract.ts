import type {
  PersonalBrowserActivityEvent,
  PersonalBrowserStatus,
  PersonalDesktopActivityEvent,
  PersonalDesktopStatus,
} from "@t3tools/contracts";

/**
 * The one place the Computer tab reads the fields hbots 1.66.98 added to the
 * browser and desktop contracts (waiting, egressPause, helpRequest.kind,
 * focusedWindow, unavailableReason). They are all optional on the wire, so an
 * older server reads as "not there". `lastStop` is not in the contract yet and
 * is read defensively.
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

/** Bots waiting for the shared browser, first in line first (optional on the wire). */
export function browserWaiting(
  status: PersonalBrowserStatus | null,
): ReadonlyArray<ComputerClaimant> {
  return status === null ? [] : readClaimants(status.waiting);
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
  const kind = help.kind ?? null;
  return kind !== null && HELP_KINDS.has(kind) ? kind : "other";
}

/** The site a human check or sign-in is about, when the server says. */
export function helpOrigin(status: PersonalBrowserStatus | null): string | null {
  const help = status?.helpRequest;
  if (help === null || help === undefined) return null;
  return asString(help.origin);
}

/** When the browser last closed, if the server says (Backend `lastStop`, optional). */
export function browserLastStop(status: PersonalBrowserStatus | null): string | null {
  return asString(asRecord(status)?.lastStop);
}

/** A sensitive-site pause waiting for Allow once / Refuse, or null. */
export function egressPause(status: PersonalBrowserStatus | null): ComputerEgressPause | null {
  const pause = status?.egressPause;
  if (pause === null || pause === undefined) {
    // The pause shows before the bot asks for help; once it does, the help
    // request carries the same destination and sources.
    const help = status?.helpRequest;
    if (help === null || help === undefined || help.kind !== "sensitive") return null;
    return {
      threadId: help.threadId,
      botId: help.botId,
      botName: help.botName,
      sources: (help.sources ?? []).join(", "),
      destination: asString(help.destination) ?? "another site",
      requestedAt: help.requestedAt,
    };
  }
  return {
    threadId: pause.threadId,
    botId: pause.botId,
    botName: pause.botName,
    sources: (pause.sources ?? []).join(", "),
    destination: asString(pause.destination) ?? "another site",
    requestedAt: pause.requestedAt,
  };
}

export function focusedWindow(status: PersonalDesktopStatus | null): FocusedWindow | null {
  const focused = status?.focusedWindow;
  if (focused === null || focused === undefined) return null;
  const title = asString(focused.title);
  if (title === null) return null;
  return { title, windowClass: focused.windowClass ?? "" };
}

/** Why the server cannot drive a desktop, when it says (Backend `unavailableReason`). */
export function desktopUnavailableReason(status: PersonalDesktopStatus | null): string | null {
  return status?.available === false ? asString(status.unavailableReason) : null;
}

export function isLinuxDesktop(status: PersonalDesktopStatus | null): boolean {
  const hotkey = status?.stopHotkey ?? "";
  return hotkey.startsWith("Super") || focusedWindow(status) !== null;
}

/** Which timeline an activity event came from. */
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

/** A desktop timeline event, in the shape the merged feed uses. */
export function readDesktopEvent(event: PersonalDesktopActivityEvent): ComputerActivityEvent {
  return {
    id: event.id,
    source: "desktop",
    kind: event.kind,
    summary: event.summary,
    status: event.status,
    at: event.at,
    threadId: event.threadId,
    botName: event.botName,
    botId: event.botId,
    point: event.x !== undefined && event.y !== undefined ? { x: event.x, y: event.y } : null,
    chars: event.chars ?? null,
  };
}
