import {
  AuthAccessTokenResult,
  AuthPhoneClientScopes,
  AuthWebSocketTicketResult,
  ExecutionEnvironmentDescriptor,
  environmentShortId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { authorizationHeaders } from "./authorizedRequest";
import { createDpopProof } from "./dpop";
import { assertSameEnvironment, DpopRequiredError } from "./failure";
import { requestJson } from "./http";
import type { PairingTarget } from "./pairingLink";
import type { StoredSession } from "./session";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeToken = Schema.decodeUnknownSync(AuthAccessTokenResult);
const WebSocketTicketWire = Schema.Struct({ ticket: AuthWebSocketTicketResult.fields.ticket });
export const decodeTicket = Schema.decodeUnknownSync(WebSocketTicketWire);

export interface ServerIdentity {
  readonly environmentId: string;
  readonly label: string;
  readonly host: string;
  readonly serverVersion: string;
  readonly shortId: string;
}

async function fetchDescriptor(
  httpBaseUrl: string,
  signal?: AbortSignal,
): Promise<ExecutionEnvironmentDescriptor> {
  const descriptor = await requestJson(
    "descriptor",
    new URL("/.well-known/t3/environment", httpBaseUrl),
    signal === undefined ? {} : { signal },
    5000,
  );
  return decodeDescriptor(descriptor);
}

function identityOf(
  descriptor: ExecutionEnvironmentDescriptor,
  httpBaseUrl: string,
): ServerIdentity {
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    host: new URL(httpBaseUrl).host,
    serverVersion: descriptor.serverVersion,
    shortId: descriptor.shortId ?? environmentShortId(descriptor.environmentId),
  };
}

export async function inspectServer(target: PairingTarget): Promise<ServerIdentity> {
  return identityOf(await fetchDescriptor(target.httpBaseUrl), target.httpBaseUrl);
}

export async function openSocketUrl(
  session: StoredSession,
  clientAppVersion: string,
  signal?: AbortSignal,
): Promise<string> {
  const descriptor = await fetchDescriptor(session.httpBaseUrl, signal);
  assertSameEnvironment(session.environmentId, descriptor.environmentId);
  const ticketUrl = new URL("/api/auth/websocket-ticket", session.httpBaseUrl);
  const ticket = await requestJson(
    "ticket",
    ticketUrl,
    {
      method: "POST",
      headers: await authorizationHeaders(session, "POST", ticketUrl.toString()),
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

export async function pair(target: PairingTarget, deviceLabel: string): Promise<StoredSession> {
  const descriptor = await fetchDescriptor(target.httpBaseUrl);
  const tokenUrl = new URL("/oauth/token", target.httpBaseUrl);
  const proof = await createDpopProof({ method: "POST", url: tokenUrl.toString() });
  const label = deviceLabel.trim();
  const token = decodeToken(
    await requestJson("pair", tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof.proof },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: target.credential,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        scope: AuthPhoneClientScopes.join(" "),
        client_label: label,
        client_device_type: "mobile",
        client_os: "android",
      }).toString(),
    }),
  );
  if (token.token_type !== "DPoP") {
    throw new DpopRequiredError();
  }
  const now = Date.now();
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    deviceLabel: label,
    httpBaseUrl: target.httpBaseUrl,
    wsBaseUrl: target.wsBaseUrl,
    accessToken: token.access_token,
    authMethod: "dpop",
    scope: token.scope,
    expiresAt: now + token.expires_in * 1000,
    pairedAt: now,
  };
}
