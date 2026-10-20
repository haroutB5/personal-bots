/**
 * Antigravity (Google AI Pro) subscription usage.
 *
 * Reads the OAuth credentials stored in the Antigravity instance profile
 * (`acp_token.json`), refreshes the token against Google's token endpoint if
 * needed, and queries the Code Assist model endpoint
 * (`https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`)
 * for per-model remaining fractions and reset times.
 *
 * Maps Gemini quota to the session window (labelled "Gemini") and Claude
 * quota (when present) to the session window (labelled "Claude").
 *
 * @module provider/Layers/antigravityUsageLimits
 */
import type {
  AntigravityAuthMethod,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const AcpToken = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.String,
  refresh_token: Schema.String,
  token_uri: Schema.optional(Schema.String),
});
const decodeAcpToken = Schema.decodeEffect(Schema.fromJsonString(AcpToken));

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
  token_type: Schema.optional(Schema.String),
});

const QuotaInfo = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});

const ModelEntry = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  quotaInfo: Schema.optional(QuotaInfo),
});

const AvailableModelsResponse = Schema.Struct({
  models: Schema.optional(Schema.Record(Schema.String, ModelEntry)),
});

export const DAILY_CLOUDCODE_ENDPOINT =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
export const PROD_CLOUDCODE_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export function antigravityAvailableModelsToLimits(
  response: typeof AvailableModelsResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const models = response.models ?? {};

  // Gemini family: tightest (lowest remainingFraction) among active bot models (Argon, Flash)
  const geminiCandidates = Object.entries(models).filter(
    ([k, v]) =>
      k.startsWith("gemini-") &&
      v.quotaInfo?.remainingFraction !== undefined &&
      Number.isFinite(v.quotaInfo.remainingFraction),
  );
  const activeGemini = geminiCandidates.filter(
    ([k]) => k.startsWith("gemini-4-argon") || k.startsWith("gemini-3.8-flash"),
  );
  const geminiPool = activeGemini.length > 0 ? activeGemini : geminiCandidates;
  const tightestGemini = geminiPool.sort(
    (a, b) => a[1].quotaInfo!.remainingFraction! - b[1].quotaInfo!.remainingFraction!,
  )[0]?.[1]?.quotaInfo;

  // Claude family: only if the account has Claude models
  const claudeCandidates = Object.entries(models).filter(
    ([k, v]) =>
      k.startsWith("claude-") &&
      v.quotaInfo?.remainingFraction !== undefined &&
      Number.isFinite(v.quotaInfo.remainingFraction),
  );
  const tightestClaude = claudeCandidates.sort(
    (a, b) => a[1].quotaInfo!.remainingFraction! - b[1].quotaInfo!.remainingFraction!,
  )[0]?.[1]?.quotaInfo;

  const windows: ServerProviderUsageWindow[] = [];

  if (tightestGemini?.remainingFraction !== undefined) {
    const usedPercent = clampPercent(Math.round((1 - tightestGemini.remainingFraction) * 100));
    windows.push({
      id: "gemini",
      kind: "session",
      label: "Gemini",
      usedPercent,
      ...(tightestGemini.resetTime ? { resetsAt: tightestGemini.resetTime } : {}),
    });
  }

  if (tightestClaude?.remainingFraction !== undefined) {
    const usedPercent = clampPercent(Math.round((1 - tightestClaude.remainingFraction) * 100));
    windows.push({
      id: "claude",
      kind: "session",
      label: "Claude",
      usedPercent,
      ...(tightestClaude.resetTime ? { resetsAt: tightestClaude.resetTime } : {}),
    });
  }

  if (windows.length === 0) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }

  return makeUsageLimits({ checkedAt, windows });
}

interface CachedAccessToken {
  readonly token: string;
  readonly expiresAtMs: number;
}
// Cache keyed by profile directory (never by raw token)
const cachedTokens = new Map<string, CachedAccessToken>();

export interface ReadAntigravityUsageLimitsInput {
  readonly profileDirectory: string;
  readonly authMethod?: AntigravityAuthMethod;
  readonly enabled?: boolean;
}

export const readAntigravityUsageLimits = Effect.fn("readAntigravityUsageLimits")(function* (
  input: ReadAntigravityUsageLimitsInput,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (input.enabled === false) return unsupported;
  if (input.authMethod !== undefined && input.authMethod !== "oauth-personal") {
    return unsupported;
  }

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tokenPath = path.join(input.profileDirectory, "antigravity-acp", "acp_token.json");

    const contents = yield* fs.readFileString(tokenPath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      }),
    );
    if (!contents.trim()) return unsupported;

    const tokenData = yield* decodeAcpToken(contents).pipe(Effect.orElseSucceed(() => null));
    if (!tokenData || !tokenData.refresh_token.trim()) return unsupported;

    // Security: never trust a tampered token_uri. Must be Google's OAuth host.
    if (tokenData.token_uri) {
      const uriOrigin = yield* Effect.try(() => new URL(tokenData.token_uri!).origin).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (uriOrigin !== "https://oauth2.googleapis.com") {
        return unsupported;
      }
    }

    const client = yield* HttpClient.HttpClient;
    const cacheKey = input.profileDirectory;
    const cached = cachedTokens.get(cacheKey);
    const nowMs = yield* Clock.currentTimeMillis;
    let accessToken: string;

    if (cached && nowMs < cached.expiresAtMs - 60_000) {
      accessToken = cached.token;
    } else {
      const refreshParams = new URLSearchParams({
        client_id: tokenData.client_id,
        client_secret: tokenData.client_secret,
        refresh_token: tokenData.refresh_token,
        grant_type: "refresh_token",
      });

      const tokenRes = yield* client.execute(
        HttpClientRequest.post(GOOGLE_TOKEN_ENDPOINT).pipe(
          HttpClientRequest.bodyText(refreshParams.toString(), "application/x-www-form-urlencoded"),
        ),
      );
      const tokenBody = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(
        yield* HttpClientResponse.filterStatusOk(tokenRes),
      );
      accessToken = tokenBody.access_token;
      const expiresInSec = tokenBody.expires_in ?? 3600;
      cachedTokens.set(cacheKey, {
        token: accessToken,
        expiresAtMs: nowMs + expiresInSec * 1000,
      });
    }

    const fetchModels = (endpoint: string) =>
      client
        .execute(
          HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.bearerToken(accessToken),
            HttpClientRequest.setHeader("User-Agent", "antigravity/1.4.0"),
            HttpClientRequest.setHeader("Content-Type", "application/json"),
            HttpClientRequest.bodyJsonUnsafe({}),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(AvailableModelsResponse)),
        );

    const body = yield* fetchModels(DAILY_CLOUDCODE_ENDPOINT).pipe(
      Effect.catch(() => fetchModels(PROD_CLOUDCODE_ENDPOINT)),
    );

    return antigravityAvailableModelsToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity could not read usage limits.",
      }),
    ),
  );
});
