import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PersonalConnectionVendorId = Schema.Literals(["github", "vercel", "neon", "upstash"]);
export type PersonalConnectionVendorId = typeof PersonalConnectionVendorId.Type;

export const ConnectionId = TrimmedNonEmptyString.pipe(Schema.brand("ConnectionId"));
export type ConnectionId = typeof ConnectionId.Type;

export const PersonalConnectionStatus = Schema.Literals([
  "connecting",
  "connected",
  "needs_reauth",
  "disabled",
  "error",
]);
export type PersonalConnectionStatus = typeof PersonalConnectionStatus.Type;

/** Client-safe state. The opaque store reference is deliberately absent. */
export const PersonalConnection = Schema.Struct({
  connectionId: ConnectionId,
  vendorId: PersonalConnectionVendorId,
  status: PersonalConnectionStatus,
  account: Schema.NullOr(
    Schema.Struct({
      accountId: Schema.String,
      accountName: Schema.String,
      teamId: Schema.NullOr(Schema.String),
      teamName: Schema.NullOr(Schema.String),
    }),
  ),
  verifiedCapabilities: Schema.Array(Schema.String),
  credentialVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  lastValidatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type PersonalConnection = typeof PersonalConnection.Type;

export const PersonalConnectionCredentials = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Redacted(Schema.String),
);
export type PersonalConnectionCredentials = typeof PersonalConnectionCredentials.Type;

export const PersonalConnectionListResult = Schema.Struct({
  connections: Schema.Array(PersonalConnection),
});
export type PersonalConnectionListResult = typeof PersonalConnectionListResult.Type;

export const PersonalConnectionConnectInput = Schema.Struct({
  vendorId: PersonalConnectionVendorId,
  credentials: PersonalConnectionCredentials,
});
export type PersonalConnectionConnectInput = typeof PersonalConnectionConnectInput.Type;

export const PersonalConnectionValidateInput = Schema.Struct({
  connectionId: ConnectionId,
  outcome: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("connected"),
      account: Schema.Struct({
        accountId: Schema.String,
        accountName: Schema.String,
        teamId: Schema.NullOr(Schema.String),
        teamName: Schema.NullOr(Schema.String),
      }),
      verifiedCapabilities: Schema.Array(Schema.String),
    }),
    Schema.Struct({ status: Schema.Literals(["needs_reauth", "error"]) }),
  ]),
});
export type PersonalConnectionValidateInput = typeof PersonalConnectionValidateInput.Type;

export const PersonalConnectionIdInput = Schema.Struct({ connectionId: ConnectionId });
export type PersonalConnectionIdInput = typeof PersonalConnectionIdInput.Type;

export const PersonalConnectionRotateInput = Schema.Struct({
  connectionId: ConnectionId,
  credentials: PersonalConnectionCredentials,
});
export type PersonalConnectionRotateInput = typeof PersonalConnectionRotateInput.Type;

export const PersonalConnectionDisconnectResult = Schema.Struct({ disconnected: Schema.Boolean });
export type PersonalConnectionDisconnectResult = typeof PersonalConnectionDisconnectResult.Type;

export class PersonalConnectionsError extends Schema.TaggedError<PersonalConnectionsError>()(
  "PersonalConnectionsError",
  { message: TrimmedNonEmptyString },
) {}
