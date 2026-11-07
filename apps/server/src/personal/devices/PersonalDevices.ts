import { PersonalDevicesError } from "@t3tools/contracts";
import type {
  AuthClientSession,
  AuthSessionId,
  PersonalDevice,
  PersonalDevicesListResult,
  PersonalDevicesRevokeResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";

type AuthSessions = Pick<EnvironmentAuth["Service"], "listClientSessions" | "revokeClientSession">;

const fallbackLabel = (session: AuthClientSession): string => {
  switch (session.client.deviceType) {
    case "mobile":
      return "Phone";
    case "desktop":
      return "Browser";
    case "tablet":
      return "Tablet";
    case "bot":
      return "Bot";
    case "unknown":
      return "Unknown device";
  }
};

/** One session as the device list shows it. The relationship is derived, never stored. */
export function toPersonalDevice(
  session: AuthClientSession,
  currentSessionId: AuthSessionId,
): PersonalDevice {
  const label = session.client.label?.trim() ?? "";
  const fields = {
    sessionId: session.sessionId,
    label: label.length > 0 ? label : fallbackLabel(session),
    deviceType: session.client.deviceType,
    os: session.client.os ?? null,
    signedInAt: session.issuedAt,
    lastSeenAt: session.lastConnectedAt,
  };
  return session.sessionId === currentSessionId
    ? { ...fields, relationship: "this-device" }
    : { ...fields, relationship: "other" };
}

const seenAt = (device: PersonalDevice): number =>
  device.lastSeenAt === null ? 0 : device.lastSeenAt.epochMilliseconds;

/** This device first, then the most recently connected. */
export function sortPersonalDevices(devices: readonly PersonalDevice[]): PersonalDevice[] {
  return [...devices].sort((left, right) => {
    if (left.relationship !== right.relationship) {
      return left.relationship === "this-device" ? -1 : 1;
    }
    return seenAt(right) - seenAt(left) || left.label.localeCompare(right.label);
  });
}

export const listPersonalDevices = (
  auth: AuthSessions,
  currentSessionId: AuthSessionId,
): Effect.Effect<PersonalDevicesListResult, PersonalDevicesError> =>
  auth.listClientSessions(currentSessionId).pipe(
    Effect.map((sessions) => ({
      devices: sortPersonalDevices(
        sessions.map((session) => toPersonalDevice(session, currentSessionId)),
      ),
    })),
    Effect.catch(() =>
      Effect.fail(new PersonalDevicesError({ message: "Could not read signed-in devices." })),
    ),
  );

/**
 * Revoking this device is Sign out's job, so it stays false here. A target that
 * is already gone also reports false: the caller converges on the same state.
 */
export const revokePersonalDevice = (
  auth: AuthSessions,
  currentSessionId: AuthSessionId,
  targetSessionId: AuthSessionId,
): Effect.Effect<PersonalDevicesRevokeResult, PersonalDevicesError> =>
  targetSessionId === currentSessionId
    ? Effect.succeed({ revoked: false })
    : auth.revokeClientSession(currentSessionId, targetSessionId).pipe(
        Effect.map((revoked) => ({ revoked })),
        Effect.catchTag("ServerAuthForbiddenOperationError", () =>
          Effect.succeed({ revoked: false }),
        ),
        Effect.catch(() =>
          Effect.fail(new PersonalDevicesError({ message: "Could not revoke that device." })),
        ),
      );
