import {
  AuthAccessTokenResult,
  AuthStandardClientScopes,
  AuthWebSocketTicketResult,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { APP_VERSION } from "./appVersion";
import type { PairingTarget } from "./pairingLink";
import type { StoredSession } from "./session";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeToken = Schema.decodeUnknownSync(AuthAccessTokenResult);
const WebSocketTicketWire = Schema.Struct({ ticket: AuthWebSocketTicketResult.fields.ticket });
export const decodeTicket = Schema.decodeUnknownSync(WebSocketTicketWire);

export interface Connection {
  readonly session: StoredSession;
  readonly socketUrl: string;
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

async function openSocketUrl(session: StoredSession): Promise<string> {
  const response = await fetch(new URL("/api/auth/websocket-ticket", session.httpBaseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  const ticket = decodeTicket(await readJson(response));
  const socketUrl = new URL("/ws", session.wsBaseUrl);
  socketUrl.searchParams.set("wsTicket", ticket.ticket);
  socketUrl.searchParams.set("clientSurface", "mobile");
  socketUrl.searchParams.set("clientDeviceType", "phone");
  socketUrl.searchParams.set("clientOs", "android");
  socketUrl.searchParams.set("clientAppVersion", APP_VERSION);
  return socketUrl.toString();
}

export async function pair(target: PairingTarget): Promise<Connection> {
  const descriptorResponse = await fetch(
    new URL("/.well-known/t3/environment", target.httpBaseUrl),
  );
  const descriptor = decodeDescriptor(await readJson(descriptorResponse));
  const tokenResponse = await fetch(new URL("/oauth/token", target.httpBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: target.credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: AuthStandardClientScopes.join(" "),
      client_label: "hbots android",
      client_device_type: "mobile",
      client_os: "android",
    }).toString(),
  });
  const token = decodeToken(await readJson(tokenResponse));
  if (token.token_type !== "Bearer") {
    throw new Error("The server issued a session this app cannot use.");
  }
  const now = Date.now();
  const session: StoredSession = {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    serverVersion: descriptor.serverVersion,
    httpBaseUrl: target.httpBaseUrl,
    wsBaseUrl: target.wsBaseUrl,
    accessToken: token.access_token,
    scope: token.scope,
    expiresAt: now + token.expires_in * 1000,
    pairedAt: now,
  };
  return { session, socketUrl: await openSocketUrl(session) };
}

export async function resume(session: StoredSession): Promise<Connection> {
  return { session, socketUrl: await openSocketUrl(session) };
}
