import type { BotRow, CachedBots } from "./botsCache";

export type BotsSource = "saved" | "server";

export type BotsConnection =
  | { readonly kind: "connecting"; readonly since: number }
  | { readonly kind: "online" }
  | { readonly kind: "offline"; readonly since: number; readonly attempt: number };

export interface BotsView {
  readonly rows: ReadonlyArray<BotRow>;
  readonly serverVersion: string | null;
  readonly source: BotsSource;
  readonly asOfMs: number;
  readonly connection: BotsConnection;
}

/** The strip waits this long so a fast start never flashes it. */
export const STRIP_DELAY_MS = 2_000;

export function savedBotsView(cache: CachedBots, now: number): BotsView {
  return {
    rows: cache.rows,
    serverVersion: cache.serverVersion,
    source: "saved",
    asOfMs: cache.savedAtMs,
    connection: { kind: "connecting", since: now },
  };
}

export function serverBotsView(cache: CachedBots): BotsView {
  return {
    rows: cache.rows,
    serverVersion: cache.serverVersion,
    source: "server",
    asOfMs: cache.savedAtMs,
    connection: { kind: "online" },
  };
}

export function connectingBotsView(view: BotsView, now: number): BotsView {
  return { ...view, connection: { kind: "connecting", since: now } };
}

export function offlineBotsView(view: BotsView, now: number, attempt: number): BotsView {
  return { ...view, connection: { kind: "offline", since: now, attempt } };
}

function clock(ms: number): string {
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Null means the list on screen is live and needs no mark. */
export function connectionStripText(view: BotsView): string | null {
  if (view.connection.kind === "online") {
    return null;
  }
  const label = view.connection.kind === "offline" ? "Offline" : "Updating";
  return `${label} · showing ${clock(view.asOfMs)}`;
}
