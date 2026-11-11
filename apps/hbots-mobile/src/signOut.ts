import * as Schema from "effect/Schema";

import { authorizationHeaders } from "./authorizedRequest";
import { classifyFailure, RequestFailure } from "./failure";
import { requestJson } from "./http";
import type { StoredSession } from "./session";

export type RemoteSignOut = "revoked" | "already-signed-out" | "server-too-old" | "unreachable";

const decodeRevoked = Schema.decodeUnknownSync(Schema.Struct({ revoked: Schema.Boolean }));

export async function revokeRemoteSession(session: StoredSession): Promise<RemoteSignOut> {
  try {
    const url = new URL("/api/auth/session/revoke", session.httpBaseUrl);
    const body = await requestJson("revoke", url, {
      method: "POST",
      headers: await authorizationHeaders(session, "POST", url.toString()),
    });
    return decodeRevoked(body).revoked ? "revoked" : "unreachable";
  } catch (cause) {
    if (
      cause instanceof RequestFailure &&
      cause.detail.kind === "http" &&
      cause.detail.status === 404
    ) {
      return "server-too-old";
    }
    return classifyFailure(cause).kind === "authDead" ? "already-signed-out" : "unreachable";
  }
}

export function describeSignOut(outcome: RemoteSignOut): string {
  switch (outcome) {
    case "revoked":
      return "Signed out. This phone was removed from your laptop.";
    case "already-signed-out":
      return "Signed out.";
    case "server-too-old":
      return "Signed out here. This hbots server is too old to remove the phone itself. Remove it in Settings > Connections.";
    case "unreachable":
      return "Signed out here. Your laptop could not be reached, so remove this phone in Settings > Connections or let the session expire in 30 days.";
    default:
      return outcome satisfies never;
  }
}

const SIGN_OUT_BODY =
  "This removes the sign-in, cached chats and notifications from this phone. Your bots keep running.";

/** The sign-out confirmation text. Unsent messages are deleted with the pairing, so the count is said. */
export function signOutConfirmBody(unsentMessages: number): string {
  if (unsentMessages <= 0) return SIGN_OUT_BODY;
  const what =
    unsentMessages === 1
      ? "1 message that has not been sent yet will be discarded."
      : `${unsentMessages} messages that have not been sent yet will be discarded.`;
  return `${SIGN_OUT_BODY} ${what}`;
}
