import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PersonalExternalMcpServerId = TrimmedNonEmptyString.pipe(
  Schema.brand("PersonalExternalMcpServerId"),
);
export type PersonalExternalMcpServerId = typeof PersonalExternalMcpServerId.Type;

export const PersonalExternalMcpScope = Schema.Literals(["shared", "team", "bot"]);
export type PersonalExternalMcpScope = typeof PersonalExternalMcpScope.Type;

/** Route prefix for the sensitive-site-guarded Streamable HTTP MCP reverse proxy. */
export const PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX = "/api/personal/external-mcp";

/** Lowercase identifier used to construct the `ext-<slug>` provider MCP server name. */
export const PERSONAL_EXTERNAL_MCP_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Maximum length for an external MCP server's display name. */
export const PERSONAL_EXTERNAL_MCP_DISPLAY_NAME_MAX_LENGTH = 80;

/** Maximum length for an external MCP server's upstream URL. */
export const PERSONAL_EXTERNAL_MCP_URL_MAX_LENGTH = 512;

/** Maximum UTF-8 byte length for an external MCP server's Bearer token. */
export const PERSONAL_EXTERNAL_MCP_TOKEN_MAX_BYTES = 4096;

export const PersonalExternalMcpServer = Schema.Struct({
  serverId: PersonalExternalMcpServerId,
  slug: Schema.String,
  displayName: Schema.String,
  url: Schema.String,
  scope: PersonalExternalMcpScope,
  scopeId: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  hasToken: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type PersonalExternalMcpServer = typeof PersonalExternalMcpServer.Type;

export const PersonalExternalMcpListResult = Schema.Struct({
  servers: Schema.Array(PersonalExternalMcpServer),
});
export type PersonalExternalMcpListResult = typeof PersonalExternalMcpListResult.Type;

export const PersonalExternalMcpCreateInput = Schema.Struct({
  slug: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  scope: PersonalExternalMcpScope,
  scopeId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  enabled: Schema.optional(Schema.Boolean),
  bearerToken: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PersonalExternalMcpCreateInput = typeof PersonalExternalMcpCreateInput.Type;

export const PersonalExternalMcpUpdateInput = Schema.Struct({
  serverId: PersonalExternalMcpServerId,
  slug: Schema.optional(TrimmedNonEmptyString),
  displayName: Schema.optional(TrimmedNonEmptyString),
  url: Schema.optional(TrimmedNonEmptyString),
  scope: Schema.optional(PersonalExternalMcpScope),
  scopeId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  enabled: Schema.optional(Schema.Boolean),
  /** Omit to keep the current token; pass null or empty string to clear it. */
  bearerToken: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PersonalExternalMcpUpdateInput = typeof PersonalExternalMcpUpdateInput.Type;

export const PersonalExternalMcpDeleteInput = Schema.Struct({
  serverId: PersonalExternalMcpServerId,
});
export type PersonalExternalMcpDeleteInput = typeof PersonalExternalMcpDeleteInput.Type;

export const PersonalExternalMcpTestConnectionInput = Schema.Struct({
  serverId: PersonalExternalMcpServerId,
});
export type PersonalExternalMcpTestConnectionInput =
  typeof PersonalExternalMcpTestConnectionInput.Type;

export const PersonalExternalMcpTestConnectionResult = Schema.Struct({
  ok: Schema.Boolean,
  statusCode: Schema.optional(Schema.Number),
  serverName: Schema.optional(Schema.String),
  serverVersion: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type PersonalExternalMcpTestConnectionResult =
  typeof PersonalExternalMcpTestConnectionResult.Type;

export class PersonalExternalMcpError extends Schema.TaggedError<PersonalExternalMcpError>()(
  "PersonalExternalMcpError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
