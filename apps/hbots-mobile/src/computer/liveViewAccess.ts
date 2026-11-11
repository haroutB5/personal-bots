import { mintWebSocketTicket } from "../pairing";

import type { StoredSession } from "../session";

/** The two live-view sockets the Computer tab opens. */
export const BROWSER_STREAM_PATH = "/api/personal/browser/stream";
export const DESKTOP_STREAM_PATH = "/api/personal/desktop/stream";

/**
 * One socket URL on the session's own base, keeping any relay path prefix.
 * The ticket is a query parameter because WebSocket cannot send an auth header.
 */
export function streamSocketUrl(session: StoredSession, path: string, ticket: string): string {
  const base = new URL(session.wsBaseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  base.pathname = `${prefix}${path}`;
  base.search = "";
  base.searchParams.set("wsTicket", ticket);
  return base.toString();
}

export interface LiveViewURLs {
  readonly browser: string;
  readonly desktop: string;
}

export async function liveViewURLs(
  session: StoredSession,
  signal?: AbortSignal,
): Promise<LiveViewURLs> {
  const ticket = await mintWebSocketTicket(session, signal);
  return {
    browser: streamSocketUrl(session, BROWSER_STREAM_PATH, ticket),
    desktop: streamSocketUrl(session, DESKTOP_STREAM_PATH, ticket),
  };
}
