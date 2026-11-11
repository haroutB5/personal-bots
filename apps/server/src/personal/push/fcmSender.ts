// @effect-diagnostics nodeBuiltinImport:off - RS256 signing of the Firebase OAuth assertion uses node:crypto.
import * as NodeCrypto from "node:crypto";

import type { PersonalBotId, PhonePushData } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as PersonalSecretRepository from "../secrets/PersonalSecretRepository.ts";
import { personalSecretStoreKey } from "../secrets/PersonalSecretService.ts";

export const FCM_SERVICE_ACCOUNT_SECRET_NAME = "HBOTS_FCM_SERVICE_ACCOUNT";
export const FCM_CONFIG_RELOAD_MS = 10 * 60_000;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const SEND_CONCURRENCY = 4;

export interface ServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly tokenUri: string;
}

export type FcmConfig =
  | { readonly kind: "disabled"; readonly reason: "no-service-account" | "bad-service-account" }
  | {
      readonly kind: "ready";
      readonly projectId: string;
      readonly credentials: ServiceAccount;
    };

const StoredServiceAccount = Schema.Struct({
  type: Schema.Literal("service_account"),
  project_id: Schema.NonEmptyString,
  private_key: Schema.NonEmptyString,
  client_email: Schema.NonEmptyString,
  token_uri: Schema.optional(Schema.String),
});
const decodeStoredServiceAccount = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredServiceAccount),
);

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

const isGoogleHttps = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".googleapis.com");
  } catch {
    return false;
  }
};

/** The key file's bytes, parsed and checked once at the boundary. */
export function parseFcmConfig(bytes: Uint8Array | null): FcmConfig {
  if (bytes === null) return { kind: "disabled", reason: "no-service-account" };
  const parsed = decodeStoredServiceAccount(new TextDecoder().decode(bytes));
  if (Option.isNone(parsed)) return { kind: "disabled", reason: "bad-service-account" };
  const account = parsed.value;
  const tokenUri = account.token_uri ?? DEFAULT_TOKEN_URI;
  if (!PROJECT_ID.test(account.project_id) || !isGoogleHttps(tokenUri)) {
    return { kind: "disabled", reason: "bad-service-account" };
  }
  try {
    NodeCrypto.createPrivateKey(account.private_key);
  } catch {
    return { kind: "disabled", reason: "bad-service-account" };
  }
  return {
    kind: "ready",
    projectId: account.project_id,
    credentials: {
      clientEmail: account.client_email,
      privateKey: Redacted.make(account.private_key),
      tokenUri,
    },
  };
}

export interface FcmKeySlot {
  readonly storeKey: string;
  readonly label: string;
}

/**
 * Where the service account may be saved, best first: the shared slot, then
 * each bot's private slot that holds this name, newest save first. The owner
 * saves it with `request_secret`, which keeps it private to the asking bot, so
 * the server reads it by name from whichever slot it landed in.
 */
export function fcmKeySlots(
  rows: ReadonlyArray<{
    readonly name: string;
    readonly botId: PersonalBotId;
    readonly shared: boolean;
    readonly fulfilledAtMs: number;
  }>,
): ReadonlyArray<FcmKeySlot> {
  const privateRows = rows
    .filter((row) => row.name === FCM_SERVICE_ACCOUNT_SECRET_NAME && !row.shared)
    .toSorted((a, b) => b.fulfilledAtMs - a.fulfilledAtMs);
  return [
    { storeKey: personalSecretStoreKey(FCM_SERVICE_ACCOUNT_SECRET_NAME), label: "shared" },
    ...privateRows.map((row) => ({
      storeKey: personalSecretStoreKey({ name: row.name, botId: row.botId, shared: false }),
      label: `bot:${row.botId}`,
    })),
  ];
}

const sameConfig = (a: FcmConfig, b: FcmConfig): boolean =>
  a.kind === "ready" && b.kind === "ready"
    ? a.projectId === b.projectId &&
      a.credentials.clientEmail === b.credentials.clientEmail &&
      a.credentials.tokenUri === b.credentials.tokenUri &&
      Redacted.value(a.credentials.privateKey) === Redacted.value(b.credentials.privateKey)
    : a.kind === b.kind;

export const fcmSendUrl = (projectId: string) =>
  `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

/** Data-only and high priority: no `notification` block, so the app builds the text itself. */
export function buildFcmMessage(token: string, data: PhonePushData) {
  return {
    message: {
      token,
      data: {
        kind: data.kind,
        notificationId: data.notificationId,
        botId: data.botId,
        threadId: data.threadId,
        v: data.v,
      },
      android: { priority: "HIGH" },
    },
  } as const;
}

export type FcmSendOutcome =
  | { readonly _tag: "Sent" }
  | { readonly _tag: "TokenGone" }
  | { readonly _tag: "Failed"; readonly reason: string };

const FcmErrorBody = Schema.Struct({
  error: Schema.optional(
    Schema.Struct({
      status: Schema.optional(Schema.String),
      details: Schema.optional(
        Schema.Array(Schema.Struct({ errorCode: Schema.optional(Schema.String) })),
      ),
    }),
  ),
});
const decodeFcmErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(FcmErrorBody));

/** What FCM's answer means for the token. Only status codes survive: never a body. */
export function classifyFcmResponse(status: number, body: string): FcmSendOutcome {
  if (status >= 200 && status < 300) return { _tag: "Sent" };
  const error = Option.getOrUndefined(decodeFcmErrorBody(body))?.error;
  const errorCode = error?.details?.find((detail) => detail.errorCode !== undefined)?.errorCode;
  const code = errorCode ?? error?.status;
  if (code === "UNREGISTERED" || code === "INVALID_ARGUMENT" || code === "NOT_FOUND") {
    return { _tag: "TokenGone" };
  }
  return { _tag: "Failed", reason: code ?? `http-${String(status)}` };
}

export class FcmHttpError extends Schema.TaggedError<FcmHttpError>()("FcmHttpError", {
  reason: Schema.String,
}) {}

export interface FcmHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export class FcmHttp extends Context.Service<
  FcmHttp,
  {
    readonly post: (
      request: FcmHttpRequest,
    ) => Effect.Effect<{ readonly status: number; readonly body: string }, FcmHttpError>;
  }
>()("t3/personal/push/FcmHttp") {}

export type FcmFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The HTTP client over any fetch. Tests pass one that points at a local stub. */
export const fcmHttpWith = (fetchImpl: FcmFetch) =>
  Layer.succeed(FcmHttp, {
    post: (request) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetchImpl(request.url, {
            method: "POST",
            headers: request.headers,
            body: request.body,
            signal: AbortSignal.timeout(15_000),
            redirect: "error",
          });
          return { status: response.status, body: (await response.text()).slice(0, 4096) };
        },
        catch: () => new FcmHttpError({ reason: "network" }),
      }),
  });

// @effect-diagnostics-next-line globalFetchInEffect:off - two bounded POSTs to Google endpoints; no redirects.
export const fcmHttpLive = fcmHttpWith((url, init) => fetch(url, init));

const base64Url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** A signed OAuth assertion for the service account. Pure given the clock. */
export function signAssertion(account: ServiceAccount, nowSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: FCM_SCOPE,
      aud: account.tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signature = NodeCrypto.sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${claims}`),
    Redacted.value(account.privateKey),
  );
  return `${header}.${claims}.${base64Url(signature)}`;
}

const AccessTokenBody = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.optional(Schema.Number),
});
const decodeAccessTokenBody = Schema.decodeUnknownOption(Schema.fromJsonString(AccessTokenBody));

export class FcmSender extends Context.Service<
  FcmSender,
  {
    readonly config: Effect.Effect<FcmConfig>;
    readonly send: (
      tokens: ReadonlyArray<string>,
      data: PhonePushData,
    ) => Effect.Effect<ReadonlyArray<{ readonly token: string; readonly outcome: FcmSendOutcome }>>;
  }
>()("t3/personal/push/FcmSender") {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* FcmHttp;
  const secretRows = yield* PersonalSecretRepository.PersonalSecretRepository;

  let cached: { readonly config: FcmConfig; readonly loadedAtMs: number } | null = null;
  const loggedDisabled = new Set<string>();
  let loggedSlot: string | null = null;
  let accessToken: {
    readonly value: Redacted.Redacted<string>;
    readonly expiresAtMs: number;
  } | null = null;

  const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

  const config: Effect.Effect<FcmConfig> = Effect.gen(function* () {
    const now = yield* nowMs;
    if (cached !== null && now - cached.loadedAtMs < FCM_CONFIG_RELOAD_MS) return cached.config;
    const rows = yield* secretRows.listByStatus("fulfilled").pipe(Effect.orElseSucceed(() => []));
    const slots = fcmKeySlots(
      rows.map((row) => ({
        name: row.name,
        botId: row.botId,
        shared: row.shared,
        fulfilledAtMs: row.fulfilledAt === null ? 0 : DateTime.toEpochMillis(row.fulfilledAt),
      })),
    );
    let stored: { readonly bytes: Uint8Array; readonly slot: FcmKeySlot } | null = null;
    for (const slot of slots) {
      const found = yield* secrets
        .get(slot.storeKey)
        .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      if (Option.isSome(found)) {
        stored = { bytes: found.value, slot };
        break;
      }
    }
    if (stored !== null && loggedSlot !== stored.slot.label) {
      loggedSlot = stored.slot.label;
      yield* Effect.logInfo("phone push key read", {
        slot: stored.slot.label,
        slotsChecked: slots.length,
      });
    }
    const loaded = parseFcmConfig(stored === null ? null : stored.bytes);
    if (cached === null || !sameConfig(cached.config, loaded)) accessToken = null;
    cached = { config: loaded, loadedAtMs: now };
    if (loaded.kind === "disabled" && !loggedDisabled.has(loaded.reason)) {
      loggedDisabled.add(loaded.reason);
      yield* Effect.logWarning("phone push is disabled", { reason: loaded.reason });
    }
    return loaded;
  });

  const mintAccessToken = (account: ServiceAccount) =>
    Effect.gen(function* () {
      const now = yield* nowMs;
      if (accessToken !== null && accessToken.expiresAtMs - ACCESS_TOKEN_REFRESH_MARGIN_MS > now) {
        return Option.some(accessToken.value);
      }
      const assertion = signAssertion(account, Math.floor(now / 1000));
      const response = yield* http.post({
        url: account.tokenUri,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      });
      if (response.status < 200 || response.status >= 300) return Option.none();
      const body = decodeAccessTokenBody(response.body);
      if (Option.isNone(body)) return Option.none();
      const value = Redacted.make(body.value.access_token);
      accessToken = { value, expiresAtMs: now + (body.value.expires_in ?? 3600) * 1000 };
      return Option.some(value);
    }).pipe(
      Effect.catchTag("FcmHttpError", () =>
        Effect.succeed(Option.none<Redacted.Redacted<string>>()),
      ),
    );

  const sendOne = (
    ready: Extract<FcmConfig, { kind: "ready" }>,
    token: string,
    data: PhonePushData,
    retryAuth: boolean,
  ): Effect.Effect<FcmSendOutcome> =>
    Effect.gen(function* () {
      const bearer = yield* mintAccessToken(ready.credentials);
      if (Option.isNone(bearer)) return { _tag: "Failed", reason: "oauth" } as const;
      const response = yield* http.post({
        url: fcmSendUrl(ready.projectId),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${Redacted.value(bearer.value)}`,
        },
        body: JSON.stringify(buildFcmMessage(token, data)),
      });
      if (response.status === 401 && retryAuth) {
        accessToken = null;
        return yield* sendOne(ready, token, data, false);
      }
      return classifyFcmResponse(response.status, response.body);
    }).pipe(
      Effect.catchTag("FcmHttpError", (error) =>
        Effect.succeed({ _tag: "Failed", reason: error.reason } as const),
      ),
    );

  const send: FcmSender["Service"]["send"] = (tokens, data) =>
    Effect.gen(function* () {
      const current = yield* config;
      if (current.kind === "disabled") return [];
      return yield* Effect.forEach(
        tokens,
        (token) =>
          sendOne(current, token, data, true).pipe(Effect.map((outcome) => ({ token, outcome }))),
        { concurrency: SEND_CONCURRENCY },
      );
    });

  return FcmSender.of({ config, send });
});

export const layer = Layer.effect(FcmSender, make);
