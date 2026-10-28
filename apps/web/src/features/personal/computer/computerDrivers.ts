import type { PersonalBrowserStatus, PersonalDesktopStatus } from "@t3tools/contracts";

import { formatElapsed, latestStep, runStartedAt } from "./computerActivity";
import {
  browserWaiting,
  desktopWaiting,
  egressPause,
  type ComputerActivityEvent,
  type ComputerClaimant,
  type ComputerSource,
} from "./computerContract";

/** Brave closes on its own this long after a bot's last step. */
export const BROWSER_IDLE_CLOSE_MS = 10 * 60 * 1000;

export type DriverState = "using" | "idle" | "you" | "none";

/** Who is at one source right now. */
export interface SourceDriver {
  readonly source: ComputerSource;
  readonly state: DriverState;
  readonly botId: string | null;
  readonly botName: string | null;
  readonly threadId: string | null;
  /** Epoch ms the current run began, when known. */
  readonly since: number | null;
}

const NO_DRIVER = (source: ComputerSource): SourceDriver => ({
  source,
  state: "none",
  botId: null,
  botName: null,
  threadId: null,
  since: null,
});

export function browserDriver(
  status: PersonalBrowserStatus | null,
  events: ReadonlyArray<ComputerActivityEvent>,
  youControl: boolean,
): SourceDriver {
  if (status === null || status.state === "offline") return NO_DRIVER("browser");
  if (youControl) return { ...NO_DRIVER("browser"), state: "you" };
  if (status.controller._tag === "Agent") {
    const { botId, botName, threadId } = status.controller;
    return {
      source: "browser",
      state: "using",
      botId,
      botName,
      threadId,
      since: runStartedAt(events, "browser", botName),
    };
  }
  if (status.lastAgent !== null && status.state === "connected") {
    const botName = botNameFor(events, "browser", status.lastAgent.threadId);
    return {
      source: "browser",
      state: "idle",
      botId: status.lastAgent.botId,
      botName,
      threadId: status.lastAgent.threadId,
      since: null,
    };
  }
  return NO_DRIVER("browser");
}

function botNameFor(
  events: ReadonlyArray<ComputerActivityEvent>,
  source: ComputerSource,
  threadId: string,
): string | null {
  return (
    events.find(
      (event) => event.source === source && event.threadId === threadId && event.botName !== null,
    )?.botName ?? null
  );
}

export function desktopDriver(
  status: PersonalDesktopStatus | null,
  youControl: boolean,
): SourceDriver {
  if (status === null || !status.available) return NO_DRIVER("desktop");
  if (youControl || status.holder?.kind === "user")
    return { ...NO_DRIVER("desktop"), state: "you" };
  if (status.holder === null) return NO_DRIVER("desktop");
  const since = Date.parse(status.holder.since);
  return {
    source: "desktop",
    state: "using",
    botId: status.holder.botId,
    botName: status.holder.botName,
    threadId: status.holder.threadId,
    since: Number.isFinite(since) ? since : null,
  };
}

export interface QueueEntry extends ComputerClaimant {
  readonly source: ComputerSource;
}

export interface DriverQueue {
  /** The bot you paused by taking control; it resumes after you. */
  readonly paused: QueueEntry | null;
  readonly next: ReadonlyArray<QueueEntry>;
}

/** Desktop line first, then the browser's, no bot twice for one source. */
export function buildQueue(input: {
  readonly browser: PersonalBrowserStatus | null;
  readonly desktop: PersonalDesktopStatus | null;
  readonly paused: SourceDriver | null;
}): DriverQueue {
  const seen = new Set<string>();
  const next: QueueEntry[] = [];
  const add = (source: ComputerSource, claimants: ReadonlyArray<ComputerClaimant>) => {
    for (const claimant of claimants) {
      const key = `${source}:${claimant.threadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({ ...claimant, source });
    }
  };
  add("desktop", desktopWaiting(input.desktop));
  add("browser", browserWaiting(input.browser));
  const paused =
    input.paused !== null && input.paused.threadId !== null && input.paused.botName !== null
      ? {
          threadId: input.paused.threadId,
          botId: input.paused.botId ?? "",
          botName: input.paused.botName,
          source: input.paused.source,
        }
      : null;
  return { paused, next };
}

export type HeaderTone = "live" | "pending" | "problem" | "idle" | "control" | "review";

const sourcePlace = (source: ComputerSource) => (source === "desktop" ? "the desktop" : "Brave");

/** Header subline, per the spec's driver-line table. */
export function headerSubline(input: {
  readonly shown: ComputerSource;
  readonly reachable: boolean;
  readonly browser: PersonalBrowserStatus | null;
  readonly browserDriver: SourceDriver;
  readonly desktopDriver: SourceDriver;
  /** In control of the shown source on this device. */
  readonly youControl: boolean;
  /** In control of the shown source from another device. */
  readonly otherDevice: boolean;
  readonly connecting: boolean;
}): { readonly text: string; readonly tone: HeaderTone } {
  if (!input.reachable) return { text: "Laptop offline", tone: "idle" };
  if (input.connecting) return { text: "Connecting", tone: "idle" };
  const pause = egressPause(input.browser);
  if (pause !== null) return { text: `${pause.botName} is waiting for your OK`, tone: "review" };
  const help = input.browser?.helpRequest;
  if (help !== null && help !== undefined) {
    return { text: `${help.botName} needs your help`, tone: "review" };
  }
  if (input.youControl) return { text: "You're in control", tone: "control" };
  if (input.otherDevice) {
    return { text: "You're controlling it from another device", tone: "control" };
  }
  const state = input.browser?.state;
  if (state === "starting") return { text: "Starting Brave…", tone: "pending" };
  if (state === "crashed") return { text: "Brave crashed", tone: "problem" };
  if (state === "locked") return { text: "Brave profile locked", tone: "problem" };
  const driver = input.shown === "desktop" ? input.desktopDriver : input.browserDriver;
  const name = driver.botName ?? "A bot";
  if (driver.state === "using") {
    return { text: `${name} is using ${sourcePlace(driver.source)}`, tone: "live" };
  }
  if (driver.state === "idle") {
    return { text: `${name} left ${sourcePlace(driver.source)} open`, tone: "idle" };
  }
  return { text: "Nobody is using it", tone: "idle" };
}

/**
 * The square Stop button's name. Only a live holder is a bot to stop; an idle
 * browser can still be closed, but naming the last bot there offered to stop a
 * bot that was already gone (QA f9e48571's cosmetic after a task is cancelled).
 */
export function stopLabelFor(input: {
  readonly source: ComputerSource;
  readonly driver: SourceDriver;
  readonly canStop: boolean;
}): string | null {
  if (!input.canStop) return null;
  if (input.driver.state === "using") return `Stop ${input.driver.botName ?? "the bot"}`;
  return input.source === "browser" ? "Close browser" : null;
}

/** The driver card's one line: "Using Brave · 3 min · clicked Buy". */
export function driverLine(input: {
  readonly driver: SourceDriver;
  readonly events: ReadonlyArray<ComputerActivityEvent>;
  readonly now: number;
}): string {
  const { driver, events, now } = input;
  const place = driver.source === "desktop" ? "the desktop" : "Brave";
  if (driver.state === "idle") {
    const last = lastStepAt(events, driver);
    if (last === null) return `Idle · ${place} stays open`;
    const left = Math.ceil((BROWSER_IDLE_CLOSE_MS - (now - last)) / 60_000);
    return left > 0 ? `Idle · ${place} stays open for ${left} min` : `Idle · ${place} is closing`;
  }
  const parts = [`Using ${place}`];
  const runStart =
    driver.since ?? runStartedAt(events, driver.source, driver.botName) ?? Number.NaN;
  if (Number.isFinite(runStart)) parts.push(formatElapsed(runStart, now));
  const step = latestStep(events, driver.source, driver.botName);
  if (step !== null) parts.push(step);
  return parts.join(" · ");
}

function lastStepAt(
  events: ReadonlyArray<ComputerActivityEvent>,
  driver: SourceDriver,
): number | null {
  const times = events
    .filter(
      (event) =>
        event.source === driver.source &&
        (driver.threadId === null || event.threadId === driver.threadId) &&
        event.botName !== null,
    )
    .map((event) => Date.parse(event.at))
    .filter(Number.isFinite);
  return times.length === 0 ? null : Math.max(...times);
}
