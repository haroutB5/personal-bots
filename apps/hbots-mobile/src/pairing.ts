import {
  AuthAccessTokenResult,
  AuthStandardClientScopes,
  AuthWebSocketTicketResult,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { assertSameEnvironment } from "./failure";
import { requestJson } from "./http";
import type { PairingTarget } from "./pairingLink";
import type { StoredSession } from "./session";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeToken = Schema.decodeUnknownSync(AuthAccessTokenResult);
const WebSocketTicketWire = Schema.Struct({ ticket: AuthWebSocketTicketResult.fields.ticket });
export const decodeTicket = Schema.decodeUnknownSync(WebSocketTicketWire);

async function fetchDescriptor(httpBaseUrl: string, signal?: AbortSignal) {
  const descriptor = await requestJson(
    "descriptor",
    new URL("/.well-known/t3/environment", httpBaseUrl),
    signal === undefined ? {} : { signal },
    5000,
  );
  return decodeDescriptor(descriptor);
}

export async function openSocketUrl(
  session: StoredSession,
  clientAppVersion: string,
  signal?: AbortSignal,
): Promise<string> {
  const descriptor = await fetchDescriptor(session.httpBaseUrl, signal);
  assertSameEnvironment(session.environmentId, descriptor.environmentId);
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
  const decodedTicket = decodeTicket(ticket);
  const socketUrl = new URL("/ws", session.wsBaseUrl);
  socketUrl.searchParams.set("wsTicket", decodedTicket.ticket);
  socketUrl.searchParams.set("clientSurface", "mobile");
  socketUrl.searchParams.set("clientDeviceType", "phone");
  socketUrl.searchParams.set("clientOs", "android");
  socketUrl.searchParams.set("clientAppVersion", clientAppVersion);
  return socketUrl.toString();
}

export async function pair(target: PairingTarget): Promise<StoredSession> {
  const descriptor = await fetchDescriptor(target.httpBaseUrl);
  const token = decodeToken(
    await requestJson("pair", new URL("/oauth/token", target.httpBaseUrl), {
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
    }),
  );
  if (token.token_type !== "Bearer") {
    throw new Error("The server issued a session this app cannot use.");
  }
  const now = Date.now();
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    httpBaseUrl: target.httpBaseUrl,
    wsBaseUrl: target.wsBaseUrl,
    accessToken: token.access_token,
    scope: token.scope,
    expiresAt: now + token.expires_in * 1000,
    pairedAt: now,
  };
}
