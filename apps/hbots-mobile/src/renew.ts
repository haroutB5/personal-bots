import { AuthAccessTokenResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { requestJson } from "./http";
import type { StoredSession } from "./session";

const decodeToken = Schema.decodeUnknownSync(AuthAccessTokenResult);

export async function renewSession(
  session: StoredSession,
  now: number = Date.now(),
): Promise<StoredSession> {
  const body = await requestJson("renew", new URL("/api/auth/session/renew", session.httpBaseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  const token = decodeToken(body);
  return {
    ...session,
    accessToken: token.access_token,
    scope: token.scope,
    expiresAt: now + token.expires_in * 1000,
  };
}
