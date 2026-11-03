import * as Schema from "effect/Schema";

import { classifyFailure, RequestFailure } from "./failure";
import { requestJson } from "./http";
import type { StoredSession } from "./session";

export type RemoteSignOut = "revoked" | "already-signed-out" | "server-too-old" | "unreachable";

const decodeRevoked = Schema.decodeUnknownSync(Schema.Struct({ revoked: Schema.Boolean }));

export async function revokeRemoteSession(session: StoredSession): Promise<RemoteSignOut> {
  try {
    const body = await requestJson(
      "revoke",
      new URL("/api/auth/session/revoke", session.httpBaseUrl),
      {
        method: "POST",
        headers: { authorization: `Bearer ${session.accessToken}` },
      },
    );
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
