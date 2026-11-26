import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import {
  PERSONAL_EXTERNAL_MCP_DISPLAY_NAME_MAX_LENGTH,
  PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX,
  PERSONAL_EXTERNAL_MCP_SLUG_PATTERN,
  PERSONAL_EXTERNAL_MCP_TOKEN_MAX_BYTES,
  PERSONAL_EXTERNAL_MCP_URL_MAX_LENGTH,
  PersonalBotId,
  PersonalBotTeam,
  PersonalExternalMcpError,
  PersonalExternalMcpServerId,
  type PersonalExternalMcpCreateInput,
  type PersonalExternalMcpDeleteInput,
  type PersonalExternalMcpListResult,
  type PersonalExternalMcpScope,
  type PersonalExternalMcpServer,
  type PersonalExternalMcpTestConnectionInput,
  type PersonalExternalMcpTestConnectionResult,
  type PersonalExternalMcpUpdateInput,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import { secretRedactor } from "../secrets/secretRedaction.ts";
import * as PersonalExternalMcpRepository from "./PersonalExternalMcpRepository.ts";

const OFF_VALUES = new Set(["off", "0", "false", "no"]);

/** Kill switch: `T3CODE_PERSONAL_EXTERNAL_MCP=off` disables session injection and proxy calls. */
export const personalExternalMcpEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const raw = env.T3CODE_PERSONAL_EXTERNAL_MCP;
  return raw === undefined || !OFF_VALUES.has(raw.trim().toLowerCase());
};

/** Secret store key for an external MCP server's upstream Bearer token. */
export const externalMcpTokenStoreKey = (serverId: PersonalExternalMcpServerId | string): string =>
  `personal-external-mcp:${serverId}`;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const validateExternalMcpSlug = (raw: string): string | null => {
  const slug = raw.trim();
  if (!PERSONAL_EXTERNAL_MCP_SLUG_PATTERN.test(slug)) return null;
  if (slug === "t3-code" || slug.startsWith("t3-code")) return null;
  return slug;
};

export const validateExternalMcpUrl = (
  raw: string,
  selfOrigins?: ReadonlySet<string>,
):
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string } => {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > PERSONAL_EXTERNAL_MCP_URL_MAX_LENGTH ||
    /\s/.test(trimmed)
  ) {
    return { ok: false, reason: "Enter a valid URL." };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "Enter a valid URL." };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "URL must not contain embedded credentials." };
  }
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  if (protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(host)) {
      return {
        ok: false,
        reason: "Plain HTTP is only allowed for loopback hosts (127.0.0.1, localhost, [::1]).",
      };
    }
  } else if (protocol !== "https:") {
    return { ok: false, reason: "URL must use https:// or loopback http://." };
  }

  const pathname = parsed.pathname.toLowerCase();
  if (
    pathname === PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX ||
    pathname.startsWith(`${PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX}/`)
  ) {
    return { ok: false, reason: "URL cannot point to hbots's own external MCP proxy route." };
  }
  if (
    selfOrigins !== undefined &&
    selfOrigins.has(parsed.origin.toLowerCase()) &&
    (pathname === "/mcp" || pathname.startsWith("/mcp/"))
  ) {
    return { ok: false, reason: "URL cannot loop back to hbots's own /mcp endpoint." };
  }

  return { ok: true, url: parsed.toString() };
};

const isTeam = Schema.is(PersonalBotTeam);

const normalizeScope = (
  scope: PersonalExternalMcpScope,
  rawScopeId: string | null | undefined,
):
  | { readonly ok: true; readonly scopeId: string | null }
  | { readonly ok: false; readonly reason: string } => {
  const trimmed = rawScopeId?.trim() ?? "";
  if (scope === "shared") {
    return { ok: true, scopeId: null };
  }
  if (scope === "team") {
    if (!isTeam(trimmed)) {
      return { ok: false, reason: "Team scope requires scopeId 'personal' or 'work'." };
    }
    return { ok: true, scopeId: trimmed };
  }
  if (trimmed.length === 0) {
    return { ok: false, reason: "Bot scope requires a botId." };
  }
  return { ok: true, scopeId: trimmed };
};

const toPublicServer = (
  row: PersonalExternalMcpRepository.PersonalExternalMcpRow,
): PersonalExternalMcpServer => ({
  serverId: row.serverId,
  slug: row.slug,
  displayName: row.displayName,
  url: row.url,
  scope: row.scope,
  scopeId: row.scopeId,
  enabled: row.enabled,
  hasToken: row.credentialRef !== null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const scrubToken = (text: string, token: string | null): string => {
  let out = secretRedactor.redactText(text);
  if (token !== null && token.length > 0) {
    out = out.replaceAll(token, "[redacted]");
  }
  return out;
};

export interface ResolvedExternalMcpTarget {
  readonly serverId: PersonalExternalMcpServerId;
  readonly slug: string;
  readonly url: string;
  readonly bearerToken: string | null;
}

export interface PersonalExternalMcpServiceShape {
  readonly list: () => Effect.Effect<PersonalExternalMcpListResult, PersonalExternalMcpError>;
  readonly create: (
    input: PersonalExternalMcpCreateInput,
  ) => Effect.Effect<PersonalExternalMcpServer, PersonalExternalMcpError>;
  readonly update: (
    input: PersonalExternalMcpUpdateInput,
  ) => Effect.Effect<PersonalExternalMcpServer, PersonalExternalMcpError>;
  readonly delete: (
    input: PersonalExternalMcpDeleteInput,
  ) => Effect.Effect<void, PersonalExternalMcpError>;
  readonly forBot: (
    botId: PersonalBotId,
  ) => Effect.Effect<ReadonlyArray<PersonalExternalMcpServer>, PersonalExternalMcpError>;
  readonly resolveForProxy: (
    serverId: PersonalExternalMcpServerId,
    botId: PersonalBotId,
  ) => Effect.Effect<Option.Option<ResolvedExternalMcpTarget>, PersonalExternalMcpError>;
  readonly testConnection: (
    input: PersonalExternalMcpTestConnectionInput,
  ) => Effect.Effect<PersonalExternalMcpTestConnectionResult, PersonalExternalMcpError>;
}

export class PersonalExternalMcpService extends Context.Service<
  PersonalExternalMcpService,
  PersonalExternalMcpServiceShape
>()("t3/personal/externalMcp/PersonalExternalMcpService") {}

export interface PersonalExternalMcpServiceOptions {
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly selfOrigins?: ReadonlySet<string>;
  readonly env?: () => NodeJS.ProcessEnv;
}

const MCP_TEST_TIMEOUT_MS = 5_000;

const parseServerInfoFromPayload = (
  payload: unknown,
): { readonly serverName?: string; readonly serverVersion?: string } => {
  if (typeof payload !== "object" || payload === null) return {};
  const result = (payload as { readonly result?: unknown }).result;
  if (typeof result !== "object" || result === null) return {};
  const info = (result as { readonly serverInfo?: unknown }).serverInfo;
  if (typeof info !== "object" || info === null) return {};
  const name = (info as { readonly name?: unknown }).name;
  const version = (info as { readonly version?: unknown }).version;
  return {
    ...(typeof name === "string" && name.trim().length > 0 ? { serverName: name.trim() } : {}),
    ...(typeof version === "string" && version.trim().length > 0
      ? { serverVersion: version.trim() }
      : {}),
  };
};

const parseMcpInitializeResponse = (
  contentType: string,
  bodyText: string,
): { readonly serverName?: string; readonly serverVersion?: string } => {
  const lower = contentType.toLowerCase();
  if (lower.includes("text/event-stream")) {
    for (const line of bodyText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (data.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(data);
        const info = parseServerInfoFromPayload(parsed);
        if (info.serverName !== undefined || info.serverVersion !== undefined) return info;
      } catch {
        // Ignore non-JSON SSE lines.
      }
    }
    return {};
  }
  try {
    return parseServerInfoFromPayload(JSON.parse(bodyText));
  } catch {
    return {};
  }
};

const computeSelfOrigins = (
  httpServer: Option.Option<HttpServer.HttpServer["Service"]>,
): ReadonlySet<string> => {
  if (Option.isNone(httpServer) || !NetAddress.isInetAddress(httpServer.value.address)) {
    return new Set<string>();
  }
  const port = httpServer.value.address.port;
  const origins = new Set<string>([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  if (!NetAddress.isUnspecified(httpServer.value.address.address)) {
    const formatted = NetAddress.formatUrlHostString(
      NetAddress.formatIp(httpServer.value.address.address),
    );
    origins.add(`http://${formatted.toLowerCase()}:${port}`);
  }
  return origins;
};

const wrapError =
  (message: string) =>
  (cause: unknown): PersonalExternalMcpError =>
    cause instanceof PersonalExternalMcpError
      ? cause
      : new PersonalExternalMcpError({ message, cause });

export const make = (options: PersonalExternalMcpServiceOptions = {}) =>
  Effect.gen(function* () {
    const repo = yield* PersonalExternalMcpRepository.PersonalExternalMcpRepository;
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const random = yield* SecureRandom.SecureRandom;
    const httpServer = yield* Effect.serviceOption(HttpServer.HttpServer);
    const selfOrigins = options.selfOrigins ?? computeSelfOrigins(httpServer);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const getEnv = options.env ?? (() => process.env);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const readToken = (credentialRef: string | null) =>
      credentialRef === null
        ? Effect.succeed<string | null>(null)
        : secretStore.get(credentialRef).pipe(
            Effect.map(
              Option.match({
                onNone: () => null,
                onSome: (bytes) => decoder.decode(bytes),
              }),
            ),
            Effect.mapError(wrapError("Could not read the external MCP server token.")),
          );

    const writeToken = (serverId: PersonalExternalMcpServerId, rawToken: string) =>
      Effect.gen(function* () {
        const token = rawToken.trim();
        const bytes = encoder.encode(token);
        if (bytes.byteLength > PERSONAL_EXTERNAL_MCP_TOKEN_MAX_BYTES) {
          return yield* new PersonalExternalMcpError({
            message: `Bearer token is too long (max ${PERSONAL_EXTERNAL_MCP_TOKEN_MAX_BYTES} bytes).`,
          });
        }
        const key = externalMcpTokenStoreKey(serverId);
        yield* secretStore
          .set(key, bytes)
          .pipe(Effect.mapError(wrapError("Could not store the external MCP server token.")));
        return key;
      });

    const removeToken = (serverId: PersonalExternalMcpServerId) =>
      secretStore
        .remove(externalMcpTokenStoreKey(serverId))
        .pipe(Effect.mapError(wrapError("Could not remove the external MCP server token.")));

    const list: PersonalExternalMcpServiceShape["list"] = () =>
      repo.list().pipe(
        Effect.map((rows) => ({ servers: rows.map(toPublicServer) })),
        Effect.mapError(wrapError("Could not list external MCP servers.")),
      );

    const create: PersonalExternalMcpServiceShape["create"] = (input) =>
      Effect.gen(function* () {
        const slug = validateExternalMcpSlug(input.slug);
        if (slug === null) {
          return yield* new PersonalExternalMcpError({
            message:
              "Slug must be lowercase letters, numbers, hyphens or underscores (max 32 chars) and cannot start with t3-code.",
          });
        }
        const displayName = input.displayName.trim();
        if (
          displayName.length === 0 ||
          displayName.length > PERSONAL_EXTERNAL_MCP_DISPLAY_NAME_MAX_LENGTH
        ) {
          return yield* new PersonalExternalMcpError({
            message: `Display name must be 1 to ${PERSONAL_EXTERNAL_MCP_DISPLAY_NAME_MAX_LENGTH} characters.`,
          });
        }
        const urlCheck = validateExternalMcpUrl(input.url, selfOrigins);
        if (!urlCheck.ok) {
          return yield* new PersonalExternalMcpError({ message: urlCheck.reason });
        }
        const scopeCheck = normalizeScope(input.scope, input.scopeId);
        if (!scopeCheck.ok) {
          return yield* new PersonalExternalMcpError({ message: scopeCheck.reason });
        }
        const existingSlug = yield* repo
          .getBySlug(slug)
          .pipe(Effect.mapError(wrapError("Could not check external MCP slug uniqueness.")));
        if (Option.isSome(existingSlug)) {
          return yield* new PersonalExternalMcpError({
            message: `An external MCP server with slug "${slug}" already exists.`,
          });
        }

        const serverId = PersonalExternalMcpServerId.make(yield* random.uuidV4());
        const now = yield* DateTime.now;
        const rawToken = input.bearerToken?.trim() ?? "";
        const credentialRef = rawToken.length > 0 ? yield* writeToken(serverId, rawToken) : null;

        const row: PersonalExternalMcpRepository.PersonalExternalMcpRow = {
          serverId,
          slug,
          displayName,
          url: urlCheck.url,
          scope: input.scope,
          scopeId: scopeCheck.scopeId,
          enabled: input.enabled ?? true,
          credentialRef,
          createdAt: now,
          updatedAt: now,
        };
        yield* repo.insert(row).pipe(
          Effect.tapError(() =>
            credentialRef !== null ? removeToken(serverId).pipe(Effect.ignore) : Effect.void,
          ),
          Effect.mapError(wrapError("Could not create the external MCP server.")),
        );
        return toPublicServer(row);
      });

    const update: PersonalExternalMcpServiceShape["update"] = (input) =>
      Effect.gen(function* () {
        const currentOpt = yield* repo
          .getById(input.serverId)
          .pipe(Effect.mapError(wrapError("Could not load the external MCP server.")));
        if (Option.isNone(currentOpt)) {
          return yield* new PersonalExternalMcpError({
            message: "External MCP server not found.",
          });
        }
        const current = currentOpt.value;

        const slug = input.slug === undefined ? current.slug : validateExternalMcpSlug(input.slug);
        if (slug === null) {
          return yield* new PersonalExternalMcpError({
            message:
              "Slug must be lowercase letters, numbers, hyphens or underscores (max 32 chars) and cannot start with t3-code.",
          });
        }
        if (slug !== current.slug) {
          const conflict = yield* repo
            .getBySlug(slug)
            .pipe(Effect.mapError(wrapError("Could not check external MCP slug uniqueness.")));
          if (Option.isSome(conflict) && conflict.value.serverId !== current.serverId) {
            return yield* new PersonalExternalMcpError({
              message: `An external MCP server with slug "${slug}" already exists.`,
            });
          }
        }

        const displayName =
          input.displayName === undefined ? current.displayName : input.displayName.trim();
        if (
          displayName.length === 0 ||
          displayName.length > PERSONAL_EXTERNAL_MCP_DISPLAY_NAME_MAX_LENGTH
        ) {
          return yield* new PersonalExternalMcpError({
            message: `Display name must be 1 to ${PERSONAL_EXTERNAL_MCP_DISPLAY_NAME_MAX_LENGTH} characters.`,
          });
        }

        let url = current.url;
        if (input.url !== undefined) {
          const urlCheck = validateExternalMcpUrl(input.url, selfOrigins);
          if (!urlCheck.ok) {
            return yield* new PersonalExternalMcpError({ message: urlCheck.reason });
          }
          url = urlCheck.url;
        }

        const nextScope = input.scope ?? current.scope;
        const nextRawScopeId =
          input.scopeId !== undefined
            ? input.scopeId
            : input.scope !== undefined && input.scope === "shared"
              ? null
              : current.scopeId;
        const scopeCheck = normalizeScope(nextScope, nextRawScopeId);
        if (!scopeCheck.ok) {
          return yield* new PersonalExternalMcpError({ message: scopeCheck.reason });
        }

        let credentialRef = current.credentialRef;
        if (input.bearerToken !== undefined) {
          const trimmedToken = input.bearerToken?.trim() ?? "";
          if (trimmedToken.length === 0) {
            if (current.credentialRef !== null) {
              yield* removeToken(current.serverId);
            }
            credentialRef = null;
          } else {
            credentialRef = yield* writeToken(current.serverId, trimmedToken);
          }
        }

        const updatedAt = yield* DateTime.now;
        const nextRow: PersonalExternalMcpRepository.PersonalExternalMcpRow = {
          serverId: current.serverId,
          slug,
          displayName,
          url,
          scope: nextScope,
          scopeId: scopeCheck.scopeId,
          enabled: input.enabled ?? current.enabled,
          credentialRef,
          createdAt: current.createdAt,
          updatedAt,
        };
        yield* repo
          .update(nextRow)
          .pipe(Effect.mapError(wrapError("Could not update the external MCP server.")));
        return toPublicServer(nextRow);
      });

    const del: PersonalExternalMcpServiceShape["delete"] = (input) =>
      Effect.gen(function* () {
        yield* repo
          .deleteById(input.serverId)
          .pipe(Effect.mapError(wrapError("Could not delete the external MCP server.")));
        yield* removeToken(input.serverId).pipe(Effect.ignore);
      });

    const forBot: PersonalExternalMcpServiceShape["forBot"] = (botId) =>
      Effect.gen(function* () {
        if (!personalExternalMcpEnabled(getEnv())) return [];
        const botOpt = yield* bots
          .getBotById({ botId })
          .pipe(Effect.mapError(wrapError("Could not look up bot for external MCP servers.")));
        if (Option.isNone(botOpt)) return [];
        const rows = yield* repo
          .listEnabledForBot({ botId, team: botOpt.value.team ?? "personal" })
          .pipe(Effect.mapError(wrapError("Could not load external MCP servers for bot.")));
        return rows.map(toPublicServer);
      });

    const resolveForProxy: PersonalExternalMcpServiceShape["resolveForProxy"] = (serverId, botId) =>
      Effect.gen(function* () {
        if (!personalExternalMcpEnabled(getEnv())) return Option.none();
        const botOpt = yield* bots
          .getBotById({ botId })
          .pipe(Effect.mapError(wrapError("Could not look up bot for external MCP proxy.")));
        if (Option.isNone(botOpt)) return Option.none();
        const rowOpt = yield* repo
          .getById(serverId)
          .pipe(Effect.mapError(wrapError("Could not load external MCP server.")));
        if (Option.isNone(rowOpt)) return Option.none();
        const row = rowOpt.value;
        if (!row.enabled) return Option.none();
        const visible =
          row.scope === "shared" ||
          (row.scope === "team" && row.scopeId === botOpt.value.team) ||
          (row.scope === "bot" && row.scopeId === botId);
        if (!visible) return Option.none();
        const bearerToken = yield* readToken(row.credentialRef);
        return Option.some<ResolvedExternalMcpTarget>({
          serverId: row.serverId,
          slug: row.slug,
          url: row.url,
          bearerToken,
        });
      });

    const testConnection: PersonalExternalMcpServiceShape["testConnection"] = (input) =>
      Effect.gen(function* () {
        const rowOpt = yield* repo
          .getById(input.serverId)
          .pipe(Effect.mapError(wrapError("Could not load external MCP server.")));
        if (Option.isNone(rowOpt)) {
          return yield* new PersonalExternalMcpError({
            message: "External MCP server not found.",
          });
        }
        const row = rowOpt.value;
        const token = yield* readToken(row.credentialRef);
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
        };
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "hbots", version: "1.0.0" },
          },
        });
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImpl(row.url, {
              method: "POST",
              headers,
              body,
              signal: AbortSignal.timeout(MCP_TEST_TIMEOUT_MS),
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.match({
            onFailure: (cause) => ({
              _tag: "Error" as const,
              message: scrubToken(cause instanceof Error ? cause.message : String(cause), token),
            }),
            onSuccess: (res) => ({ _tag: "Response" as const, res }),
          }),
        );

        if (response._tag === "Error") {
          return {
            ok: false,
            error: response.message,
          } satisfies PersonalExternalMcpTestConnectionResult;
        }

        const res = response.res;
        const bodyText = yield* Effect.tryPromise({
          try: () => res.text(),
          catch: () => "",
        }).pipe(Effect.orElseSucceed(() => ""));

        if (!res.ok) {
          const snippet = scrubToken(bodyText.trim().slice(0, 240), token);
          return {
            ok: false,
            statusCode: res.status,
            error: snippet.length > 0 ? snippet : `HTTP ${res.status}`,
          } satisfies PersonalExternalMcpTestConnectionResult;
        }

        const info = parseMcpInitializeResponse(res.headers.get("content-type") ?? "", bodyText);
        return {
          ok: true,
          statusCode: res.status,
          ...(info.serverName !== undefined
            ? { serverName: scrubToken(info.serverName, token) }
            : {}),
          ...(info.serverVersion !== undefined
            ? { serverVersion: scrubToken(info.serverVersion, token) }
            : {}),
        } satisfies PersonalExternalMcpTestConnectionResult;
      });

    return {
      list,
      create,
      update,
      delete: del,
      forBot,
      resolveForProxy,
      testConnection,
    } satisfies PersonalExternalMcpServiceShape;
  });

export const layer = Layer.effect(PersonalExternalMcpService, make());

export const layerLive = layer.pipe(
  Layer.provide(PersonalExternalMcpRepository.layer),
  Layer.provide(PersonalBotRepository.layer),
  Layer.provide(ServerSecretStore.layer),
);
