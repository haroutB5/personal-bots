import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as SecureStore from "expo-secure-store";

import { createDpopProof, loadOrCreateDpopKeyPair, type DpopKeyPair } from "./dpop";

export interface PairingTarget {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly credential: string;
}

export interface Session {
  readonly environmentId: string;
  readonly label: string;
  readonly serverVersion: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly accessToken: string;
  readonly tokenType: "Bearer" | "DPoP";
  readonly scope: string;
  readonly expiresAt: number;
  readonly pairedAt: number;
}

export interface PairingTimings {
  readonly descriptorMs: number;
  readonly tokenMs: number;
  readonly ticketMs: number;
  readonly totalMs: number;
}

export interface ConnectResult {
  readonly session: Session;
  readonly dpopKey: DpopKeyPair | null;
  readonly socketUrl: string;
  readonly timings: PairingTimings;
}

const SESSION_STORAGE_ID = "hbots.spike.session.v1";

function toHttpBase(url: URL): string {
  const next = new URL(url.toString());
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
}

function toWsBase(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function parsePairingUrl(raw: string): PairingTarget {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("Paste the pairing link first.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("That is not a URL. Paste the full pairing link.");
  }
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const credential = (hash.get("token") ?? url.searchParams.get("token") ?? "").trim();
  if (credential.length === 0) {
    throw new Error("The link has no token.");
  }
  const httpBaseUrl = toHttpBase(url);
  return { httpBaseUrl, wsBaseUrl: toWsBase(httpBaseUrl), credential };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `HTTP ${String(response.status)} ${response.statusText}: ${text.slice(0, 240)}`,
    );
  }
  return JSON.parse(text) as unknown;
}

interface Descriptor {
  readonly environmentId: string;
  readonly label: string;
  readonly serverVersion: string;
}

interface TokenResult {
  readonly access_token: string;
  readonly token_type: "Bearer" | "DPoP";
  readonly expires_in: number;
  readonly scope: string;
}

export async function connect(
  target: PairingTarget,
  options: { readonly useDpop: boolean },
): Promise<ConnectResult> {
  const startedAt = Date.now();
  const descriptorResponse = await fetch(
    new URL("/.well-known/t3/environment", target.httpBaseUrl).toString(),
  );
  const descriptor = (await readJson(descriptorResponse)) as Descriptor;
  const descriptorMs = Date.now() - startedAt;

  const dpopKey = options.useDpop ? await loadOrCreateDpopKeyPair() : null;
  const tokenUrl = new URL("/oauth/token", target.httpBaseUrl).toString();
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (dpopKey !== null) {
    headers.dpop = await createDpopProof({ method: "POST", url: tokenUrl, key: dpopKey });
  }
  const tokenStartedAt = Date.now();
  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: target.credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: AuthStandardClientScopes.join(" "),
      client_label: "hbots-spike",
      client_device_type: "mobile",
      client_os: "android",
    }).toString(),
  });
  const token = (await readJson(tokenResponse)) as TokenResult;
  const tokenMs = Date.now() - tokenStartedAt;

  const ticketUrl = new URL("/api/auth/websocket-ticket", target.httpBaseUrl).toString();
  const ticketHeaders: Record<string, string> = {
    authorization: `${token.token_type} ${token.access_token}`,
  };
  if (dpopKey !== null) {
    ticketHeaders.dpop = await createDpopProof({
      method: "POST",
      url: ticketUrl,
      key: dpopKey,
      accessToken: token.access_token,
    });
  }
  const ticketStartedAt = Date.now();
  const ticketResponse = await fetch(ticketUrl, { method: "POST", headers: ticketHeaders });
  const ticket = (await readJson(ticketResponse)) as { ticket: string };
  const ticketMs = Date.now() - ticketStartedAt;

  const socketUrl = new URL("/ws", target.wsBaseUrl);
  socketUrl.searchParams.set("wsTicket", ticket.ticket);
  socketUrl.searchParams.set("clientSurface", "mobile");
  socketUrl.searchParams.set("clientDeviceType", "phone");
  socketUrl.searchParams.set("clientOs", "android");
  socketUrl.searchParams.set("clientAppVersion", "0.0.1");
  socketUrl.searchParams.set("clientDeviceModel", "FindX9Pro");

  return {
    session: {
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      serverVersion: descriptor.serverVersion,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      accessToken: token.access_token,
      tokenType: token.token_type,
      scope: token.scope,
      expiresAt: Date.now() + token.expires_in * 1000,
      pairedAt: Date.now(),
    },
    dpopKey,
    socketUrl: socketUrl.toString(),
    timings: { descriptorMs, tokenMs, ticketMs, totalMs: Date.now() - startedAt },
  };
}

export interface ResumeResult {
  readonly dpopKey: DpopKeyPair | null;
  readonly socketUrl: string;
  readonly ticketMs: number;
}

export async function resume(session: Session): Promise<ResumeResult> {
  const dpopKey = session.tokenType === "DPoP" ? await loadOrCreateDpopKeyPair() : null;
  const ticketUrl = new URL("/api/auth/websocket-ticket", session.httpBaseUrl).toString();
  const headers: Record<string, string> = {
    authorization: `${session.tokenType} ${session.accessToken}`,
  };
  if (dpopKey !== null) {
    headers.dpop = await createDpopProof({
      method: "POST",
      url: ticketUrl,
      key: dpopKey,
      accessToken: session.accessToken,
    });
  }
  const startedAt = Date.now();
  const response = await fetch(ticketUrl, { method: "POST", headers });
  const ticket = (await readJson(response)) as { ticket: string };
  const socketUrl = new URL("/ws", session.wsBaseUrl);
  socketUrl.searchParams.set("wsTicket", ticket.ticket);
  socketUrl.searchParams.set("clientSurface", "mobile");
  socketUrl.searchParams.set("clientDeviceType", "phone");
  socketUrl.searchParams.set("clientOs", "android");
  socketUrl.searchParams.set("clientAppVersion", "0.0.1");
  socketUrl.searchParams.set("clientDeviceModel", "FindX9Pro");
  return { dpopKey, socketUrl: socketUrl.toString(), ticketMs: Date.now() - startedAt };
}

export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(SESSION_STORAGE_ID, JSON.stringify(session));
}

export async function loadSession(): Promise<Session | null> {
  const stored = await SecureStore.getItemAsync(SESSION_STORAGE_ID);
  if (stored === null) {
    return null;
  }
  try {
    return JSON.parse(stored) as Session;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_STORAGE_ID);
}
