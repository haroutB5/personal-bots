import type { ConversationItem } from "./conversationModel";

import { useEffect, useRef, useState } from "react";

/** A working turn that has sent nothing this long reads as "No response from <provider>". */
export const SILENCE_THRESHOLD_MS = 90_000;

/**
 * The cards that hold a turn on the owner: while one is open the bot is
 * waiting on them, not silent. (A pending question or provider approval is
 * not "working" at all, `deriveConversationState`; these are the ones the
 * state does not know about.)
 */
export function ownerCardPending(items: ReadonlyArray<ConversationItem>): boolean {
  return items.some((item) => {
    switch (item.kind) {
      case "question":
      case "secret":
      case "connection-approval":
      case "lead-bot-change":
        return item.card.kind === "pending";
      case "login":
        return item.request.status === "pending" || item.request.status === "filling";
      default:
        return false;
    }
  });
}

/** "1m 30s", "2m", "1h 5m": whole units, seconds only while under an hour. */
export function formatSilence(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** The status line of a working bot that has gone quiet. */
export function quietNoticeText(provider: string, silentMs: number): string {
  return `No response from ${provider} · ${formatSilence(silentMs)}`;
}

function parseMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * When the provider last sent anything, in epoch ms, from what the open chat
 * already holds: the newest of the stamps the caller passes (the thread's
 * `updatedAt` moves with every event of the turn, text deltas and tool steps
 * included). A stamp from a clock ahead of this one is clamped to now.
 */
export function lastOutputMs(
  stamps: ReadonlyArray<string | null | undefined>,
  nowMs: number,
): number | null {
  let newest: number | null = null;
  for (const stamp of stamps) {
    const ms = parseMs(stamp);
    if (ms !== null && (newest === null || ms > newest)) newest = ms;
  }
  return newest === null ? null : Math.min(newest, nowMs);
}

/**
 * The moment (epoch ms) the open chat went quiet, or null while it has not,
 * or while `active` is false (not working, offline, waiting on the owner).
 *
 * The clock starts at the chat's own last event. Once this screen has seen a
 * change, or `active` come back, it starts from when the screen saw it, so a
 * phone whose clock differs from the laptop's still counts from the moment
 * output stopped arriving. A chat opened (or switched to) in the middle of a
 * silence keeps counting from the server's stamp. A single timer fires when
 * the threshold passes; the screen does not re-render per second (the notice
 * ticks itself).
 */
export function useQuietSince(input: {
  readonly active: boolean;
  /** The chat this reading belongs to; a new one starts again from its own stamps. */
  readonly chatKey: string;
  readonly stamps: ReadonlyArray<string | null | undefined>;
  readonly thresholdMs?: number;
}): number | null {
  const threshold = input.thresholdMs ?? SILENCE_THRESHOLD_MS;
  const stampKey = input.stamps.join("|");
  const [sinceMs, setSinceMs] = useState<number | null>(() =>
    lastOutputMs(input.stamps, Date.now()),
  );
  const previous = useRef({ chatKey: input.chatKey, loaded: sinceMs !== null });
  const opening = useRef(true);
  useEffect(() => {
    // The first run is the screen opening: `sinceMs` already holds the server's stamp.
    if (opening.current) {
      opening.current = false;
      return;
    }
    const nowMs = Date.now();
    const fromServer = lastOutputMs(input.stamps, nowMs);
    const seen = previous.current;
    previous.current = { chatKey: input.chatKey, loaded: fromServer !== null };
    // The chat just switched, or its first stamps just arrived: those stamps
    // are history. Anything after that is output this screen watched arrive.
    setSinceMs(seen.chatKey !== input.chatKey || !seen.loaded ? fromServer : nowMs);
    // `stampKey` stands for `input.stamps`, whose identity changes every render.
  }, [stampKey, input.active, input.chatKey]);

  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    if (!input.active || sinceMs === null) {
      setQuiet(false);
      return;
    }
    const remaining = sinceMs + threshold - Date.now();
    if (remaining <= 0) {
      setQuiet(true);
      return;
    }
    setQuiet(false);
    const timer = setTimeout(() => setQuiet(true), remaining);
    return () => clearTimeout(timer);
  }, [input.active, sinceMs, threshold]);

  return input.active && quiet ? sinceMs : null;
}
