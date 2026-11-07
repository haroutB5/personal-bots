import * as Schema from "effect/Schema";

import { AuthClientMetadataDeviceType } from "./auth.ts";
import { AuthSessionId } from "./baseSchemas.ts";

/**
 * Who a session belongs to as far as Settings > Devices shows it. The phone
 * cannot revoke itself from this list; Sign out owns that path.
 */
export class PersonalDevicesError extends Schema.TaggedError<PersonalDevicesError>()(
  "PersonalDevicesError",
  {
    message: Schema.String,
  },
) {}

export const PersonalDeviceRelationship = Schema.Literals(["this-device", "other"]);
export type PersonalDeviceRelationship = typeof PersonalDeviceRelationship.Type;

const PersonalDeviceFields = {
  sessionId: AuthSessionId,
  label: Schema.String,
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.NullOr(Schema.String),
  signedInAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtc),
};

export const PersonalDevice = Schema.Union([
  Schema.Struct({ ...PersonalDeviceFields, relationship: Schema.Literal("this-device") }),
  Schema.Struct({ ...PersonalDeviceFields, relationship: Schema.Literal("other") }),
]);
export type PersonalDevice = typeof PersonalDevice.Type;

export const PersonalDevicesListResult = Schema.Struct({
  devices: Schema.Array(PersonalDevice),
});
export type PersonalDevicesListResult = typeof PersonalDevicesListResult.Type;

export const PersonalDevicesRevokeInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type PersonalDevicesRevokeInput = typeof PersonalDevicesRevokeInput.Type;

/** False when the session is already gone or is this device. Revoke is idempotent. */
export const PersonalDevicesRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type PersonalDevicesRevokeResult = typeof PersonalDevicesRevokeResult.Type;
