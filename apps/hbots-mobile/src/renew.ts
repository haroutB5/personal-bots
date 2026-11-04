import { AuthAccessTokenResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { authorizationHeaders } from "./authorizedRequest";
import { requestJson } from "./http";
import type { StoredSession } from "./session";

const decodeToken = Schema.decodeUnknownSync(AuthAccessTokenResult);

export async function renewSession(
  session: StoredSession,
  now: number = Date.now(),
): Promise<StoredSession> {
  const url = new URL("/api/auth/session/renew", session.httpBaseUrl);
  const body = await requestJson("renew", url, {
    method: "POST",
    headers: await authorizationHeaders(session, "POST", url.toString()),
  });
  const token = decodeToken(body);
  return {
    ...session,
    accessToken: token.access_token,
    authMethod: token.token_type === "DPoP" ? "dpop" : "bearer",
    scope: token.scope,
    expiresAt: now + token.expires_in * 1000,
  };
}
