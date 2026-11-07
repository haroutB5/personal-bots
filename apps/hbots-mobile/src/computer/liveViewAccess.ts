import { requestJson } from "../http";
import { decodeTicket } from "../pairing";
import * as Redacted from "effect/Redacted";

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

/** A five-minute ticket, bound to the session, for a live-view socket. */
export async function mintStreamTicket(
  session: StoredSession,
  signal?: AbortSignal,
): Promise<string> {
  const ticket = await requestJson(
    "ticket",
    new URL("/api/auth/websocket-ticket", session.httpBaseUrl),
    {
      method: "POST",
      headers: { authorization: `Bearer ${session.accessToken}` },
      ...(signal === undefined ? {} : { signal }),
    },
    5000,
  );
  return Redacted.value(decodeTicket(ticket).ticket);
}

export interface LiveViewURLs {
  readonly browser: string;
  readonly desktop: string;
}

export async function liveViewURLs(
  session: StoredSession,
  signal?: AbortSignal,
): Promise<LiveViewURLs> {
  const ticket = await mintStreamTicket(session, signal);
  return {
    browser: streamSocketUrl(session, BROWSER_STREAM_PATH, ticket),
    desktop: streamSocketUrl(session, DESKTOP_STREAM_PATH, ticket),
  };
}
