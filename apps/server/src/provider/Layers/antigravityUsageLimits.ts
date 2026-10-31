import {
  type AntigravityAuthMethod,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
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

const LoadCodeAssistResponse = Schema.Struct({
  cloudaicompanionProject: Schema.optional(Schema.String),
  paidTier: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
    }),
  ),
});

const QuotaBucket = Schema.Struct({
  bucketId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});

const QuotaGroup = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(QuotaBucket)),
});

export const QuotaSummaryResponse = Schema.Struct({
  groups: Schema.optional(Schema.Array(QuotaGroup)),
});

const ModelQuota = Schema.Struct({
  quotaInfo: Schema.optional(
    Schema.Struct({
      remainingFraction: Schema.optional(Schema.Number),
      resetTime: Schema.optional(Schema.String),
    }),
  ),
});

export const AvailableModelsResponse = Schema.Struct({
  models: Schema.optional(Schema.Record(Schema.String, ModelQuota)),
});

const FIVE_HOURS_MS = 5 * 60 * 60_000;
/**
 * A small clock-skew margin so a 5-hour rolling reset (which Google stamps at
 * the server's `now + 5h` when `checkedAt` was recorded just before the HTTP
 * round-trip) stays on the 5-hour session window instead of crossing 5 hours
 * by a second and misclassifying as Weekly.
 */
const SESSION_WINDOW_MAX_MS = FIVE_HOURS_MS + 10 * 60_000;

/**
 * The structured aidev `User-Agent` the Antigravity ACP runtime sends on CCPA
 * calls (`useragent.py` in `agy_acp_server.par`). Without `(aidev_client; ...)`,
 * CCPA does not attribute the request to `ClientType_ANTIGRAVITY` and omits
 * `gemini-4-argon-*` from `fetchAvailableModels` as well as the `Gemini Models`
 * and `Gemini 4 Argon` groups from `retrieveUserQuotaSummary`.
 */
export const ANTIGRAVITY_CCPA_USER_AGENT =
  "antigravity/acp/1.4.0 (aidev_client; os_type=linux; arch=amd64; host_path=unknown/unknown; proxy_client=antigravity/sdk)";

export const DAILY_AVAILABLE_MODELS_ENDPOINT =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
export const PROD_AVAILABLE_MODELS_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

/**
 * Gemini usage as the runtime actually counts it. On 21 Oct 2026 the quota
 * summary read 100% left for Gemini (its reset rolling forward on every read)
 * while the per-model list on the daily host read 81% left with a fixed reset,
 * after hours of bot use. And on Google AI Pro (seen 31 Oct 2026), Gemini 4
 * Argon has its own weekly bucket (~7 days out) while Gemini Flash/Pro report
 * a 5-hour session reset (~5 hours out). So per-model Gemini entries are split
 * into session (reset within 5h + margin) and weekly (reset further out),
 * taking the tightest model in each bucket and merging with any tighter figure
 * from the quota summary.
 */
export function antigravityUsageToLimits(
  models: typeof AvailableModelsResponse.Type | null,
  summary: typeof QuotaSummaryResponse.Type | null,
  checkedAt: string,
): ServerProviderUsageLimits {
  const checkedMs = Date.parse(checkedAt);
  // Google's JSON leaves a zero out: a model with quota info and a reset but no
  // remainingFraction is spent (seen live on 21 Oct 2026, weekly quota gone).
  const geminiModels = Object.entries(models?.models ?? {}).flatMap(([id, entry]) => {
    const info = entry.quotaInfo;
    if (!id.startsWith("gemini") || info === undefined) return [];
    const remainingFraction =
      info.remainingFraction ?? (info.resetTime !== undefined ? 0 : undefined);
    if (remainingFraction === undefined || !Number.isFinite(remainingFraction)) return [];
    const resetMs = info.resetTime ? Date.parse(info.resetTime) : Number.NaN;
    const isWeekly =
      Number.isFinite(checkedMs) &&
      Number.isFinite(resetMs) &&
      resetMs - checkedMs > SESSION_WINDOW_MAX_MS;
    return [{ remainingFraction, resetTime: info.resetTime, isWeekly }];
  });

  const summaryWindows = summary ? antigravityQuotaSummaryToLimits(summary, checkedAt).windows : [];
  if (geminiModels.length === 0) {
    return summaryWindows.length > 0
      ? makeUsageLimits({ checkedAt, windows: summaryWindows })
      : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }

  const tightestSession = geminiModels
    .filter((m) => !m.isWeekly)
    .sort((a, b) => a.remainingFraction - b.remainingFraction)[0];
  const tightestWeekly = geminiModels
    .filter((m) => m.isWeekly)
    .sort((a, b) => a.remainingFraction - b.remainingFraction)[0];

  const summarySession = summaryWindows.find((w) => w.id === "gemini-session");
  const summaryWeekly = summaryWindows.find((w) => w.id === "gemini-weekly");

  const windows: ServerProviderUsageWindow[] = [];

  if (tightestSession) {
    const modelUsed = clampPercent(Math.round((1 - tightestSession.remainingFraction) * 100));
    if (summarySession && summarySession.usedPercent > modelUsed) {
      windows.push(summarySession);
    } else {
      windows.push({
        id: "gemini-session",
        kind: "session",
        label: "Gemini · 5-hour session",
        usedPercent: modelUsed,
        ...(tightestSession.resetTime ? { resetsAt: tightestSession.resetTime } : {}),
      });
    }
  } else if (summarySession && summarySession.usedPercent > 0) {
    windows.push(summarySession);
  }

  if (tightestWeekly) {
    const modelUsed = clampPercent(Math.round((1 - tightestWeekly.remainingFraction) * 100));
    if (summaryWeekly && summaryWeekly.usedPercent > modelUsed) {
      windows.push(summaryWeekly);
    } else {
      windows.push({
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: modelUsed,
        ...(tightestWeekly.resetTime ? { resetsAt: tightestWeekly.resetTime } : {}),
      });
    }
  } else if (summaryWeekly && (summaryWeekly.usedPercent > 0 || windows.length === 0)) {
    windows.push(summaryWeekly);
  }

  if (windows.length === 0) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  return makeUsageLimits({ checkedAt, windows });
}

export const DAILY_LOAD_CODE_ASSIST_ENDPOINT =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
export const PROD_LOAD_CODE_ASSIST_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
export const DAILY_QUOTA_SUMMARY_ENDPOINT =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
export const PROD_QUOTA_SUMMARY_ENDPOINT =
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export function antigravityQuotaSummaryToLimits(
  response: typeof QuotaSummaryResponse.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const groups = response.groups ?? [];
  const windows: ServerProviderUsageWindow[] = [];

  const geminiBuckets = groups
    .filter((g) => g.displayName?.toLowerCase().includes("gemini"))
    .flatMap((g) => g.buckets ?? []);

  if (geminiBuckets.length > 0) {
    const sessionBucket = geminiBuckets
      .filter(
        (b) =>
          (b.window === "5h" ||
            b.bucketId === "gemini-5h" ||
            b.displayName?.toLowerCase().includes("five hour")) &&
          b.remainingFraction !== undefined &&
          Number.isFinite(b.remainingFraction),
      )
      .sort((a, b) => a.remainingFraction! - b.remainingFraction!)[0];
    if (sessionBucket?.remainingFraction !== undefined) {
      windows.push({
        id: "gemini-session",
        kind: "session",
        label: "Gemini · 5-hour session",
        usedPercent: clampPercent(Math.round((1 - sessionBucket.remainingFraction) * 100)),
        ...(sessionBucket.resetTime ? { resetsAt: sessionBucket.resetTime } : {}),
      });
    }

    const weeklyBucket = geminiBuckets
      .filter(
        (b) =>
          (b.window === "weekly" ||
            b.bucketId === "gemini-weekly" ||
            b.bucketId?.includes("weekly") ||
            b.displayName?.toLowerCase().includes("weekly")) &&
          b.remainingFraction !== undefined &&
          Number.isFinite(b.remainingFraction),
      )
      .sort((a, b) => a.remainingFraction! - b.remainingFraction!)[0];
    if (weeklyBucket?.remainingFraction !== undefined) {
      windows.push({
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: clampPercent(Math.round((1 - weeklyBucket.remainingFraction) * 100)),
        ...(weeklyBucket.resetTime ? { resetsAt: weeklyBucket.resetTime } : {}),
      });
    }
  }

  if (windows.length === 0) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }

  return makeUsageLimits({ checkedAt, windows });
}

export interface AntigravityQuotaHit {
  /** The reset the notice stated; it decides which window is spent. */
  readonly retryAt: string;
  /** When the notice stops counting (model-visible text is trusted for at most five hours). */
  readonly expiresAt?: string;
  readonly group?: "gemini";
}

/**
 * Google's quota summary has been seen reading 0% while the runtime refuses
 * prompts for a spent quota, so the runtime's own notice wins until its reset:
 * the matching window shows 100% with the reset the notice gave (a reset more
 * than five hours out is the weekly window).
 */
export function withAntigravityQuotaHit(
  limits: ServerProviderUsageLimits,
  hit: AntigravityQuotaHit | undefined,
  nowMs: number,
): ServerProviderUsageLimits {
  if (!hit) return limits;
  const resetMs = Date.parse(hit.retryAt);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return limits;
  const expiresMs = hit.expiresAt === undefined ? resetMs : Date.parse(hit.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return limits;
  const weekly = resetMs - nowMs > SESSION_WINDOW_MAX_MS;
  const id = `gemini-${weekly ? "weekly" : "session"}`;
  const windows = limits.unavailable ? [] : [...limits.windows];
  const index = windows.findIndex((window) => window.id === id);
  if (index >= 0) {
    windows[index] = { ...windows[index]!, usedPercent: 100, resetsAt: hit.retryAt };
  } else {
    windows.push({
      id,
      kind: weekly ? "weekly" : "session",
      label: `Gemini · ${weekly ? "Weekly" : "5-hour session"}`,
      usedPercent: 100,
      resetsAt: hit.retryAt,
    });
  }
  return makeUsageLimits({ checkedAt: limits.checkedAt, windows });
}

interface CachedAccessToken {
  readonly token: string;
  readonly expiresAtMs: number;
}
// Cache keyed by profile directory (never by raw token)
const cachedTokens = new Map<string, CachedAccessToken>();
const cachedProjects = new Map<string, string>();

export function resetAntigravityUsageCache(): void {
  cachedTokens.clear();
  cachedProjects.clear();
}

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

    let project = cachedProjects.get(cacheKey);
    if (!project) {
      const fetchCodeAssist = (endpoint: string) =>
        client
          .execute(
            HttpClientRequest.post(endpoint).pipe(
              HttpClientRequest.bearerToken(accessToken),
              HttpClientRequest.setHeader("User-Agent", ANTIGRAVITY_CCPA_USER_AGENT),
              HttpClientRequest.setHeader("Content-Type", "application/json"),
              HttpClientRequest.bodyJsonUnsafe({ metadata: { ideType: "ANTIGRAVITY" } }),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(LoadCodeAssistResponse)),
          );

      const codeAssistBody = yield* fetchCodeAssist(DAILY_LOAD_CODE_ASSIST_ENDPOINT).pipe(
        Effect.catch(() => fetchCodeAssist(PROD_LOAD_CODE_ASSIST_ENDPOINT)),
        Effect.orElseSucceed(() => null),
      );

      if (codeAssistBody?.cloudaicompanionProject) {
        project = codeAssistBody.cloudaicompanionProject;
        cachedProjects.set(cacheKey, project);
      }
    }

    const effectiveProject = project ?? "aicode-consumers";

    const fetchQuotaSummary = (endpoint: string) =>
      client
        .execute(
          HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.bearerToken(accessToken),
            HttpClientRequest.setHeader("User-Agent", ANTIGRAVITY_CCPA_USER_AGENT),
            HttpClientRequest.setHeader("Content-Type", "application/json"),
            HttpClientRequest.bodyJsonUnsafe({ project: effectiveProject }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(QuotaSummaryResponse)),
        );

    const fetchModels = (endpoint: string) =>
      client
        .execute(
          HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.bearerToken(accessToken),
            HttpClientRequest.setHeader("User-Agent", ANTIGRAVITY_CCPA_USER_AGENT),
            HttpClientRequest.setHeader("Content-Type", "application/json"),
            HttpClientRequest.bodyJsonUnsafe({ project: effectiveProject }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(AvailableModelsResponse)),
        );

    // The daily host carries the live per-model counts; prod is the fallback.
    const modelsBody = yield* fetchModels(DAILY_AVAILABLE_MODELS_ENDPOINT).pipe(
      Effect.catch(() => fetchModels(PROD_AVAILABLE_MODELS_ENDPOINT)),
      Effect.orElseSucceed(() => null),
    );

    const dailyQuota = yield* fetchQuotaSummary(DAILY_QUOTA_SUMMARY_ENDPOINT).pipe(
      Effect.orElseSucceed(() => null),
    );
    const hasGemini = dailyQuota?.groups?.some((g) =>
      g.displayName?.toLowerCase().includes("gemini"),
    );
    const summaryBody = hasGemini
      ? dailyQuota
      : yield* fetchQuotaSummary(PROD_QUOTA_SUMMARY_ENDPOINT).pipe(
          Effect.orElseSucceed(() => null),
        );

    if (modelsBody === null && summaryBody === null) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity could not read usage limits.",
      });
    }
    return antigravityUsageToLimits(modelsBody, summaryBody, checkedAt);
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
