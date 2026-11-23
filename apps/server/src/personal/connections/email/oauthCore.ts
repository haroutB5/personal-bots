import * as Redacted from "effect/Redacted";

import type { OAuthFormResponse } from "./oauthHttp.ts";

export interface TokenGrant {
  readonly accessToken: Redacted.Redacted<string>;
  readonly refreshToken: Redacted.Redacted<string> | null;
  readonly expiresInSec: number;
  readonly scopes: ReadonlyArray<string>;
}

/**
 * Why a token endpoint said no, reduced to what the app does about it.
 * `invalid_grant` is the one that means the owner has to sign in again.
 */
export type TokenRefusalKind =
  | "invalid_grant"
  | "invalid_client"
  | "unauthorized_client"
  | "pending"
  | "slow_down"
  | "expired"
  | "declined"
  | "other";

export type TokenReply =
  | { readonly _tag: "granted"; readonly grant: TokenGrant }
  | {
      readonly _tag: "refused";
      readonly kind: TokenRefusalKind;
      /** The provider's own words, cut short. May quote a request, so it is scrubbed before it is shown. */
      readonly description: string;
    };

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const REFUSALS: Readonly<Record<string, TokenRefusalKind>> = {
  invalid_grant: "invalid_grant",
  // Microsoft answers a refresh after the owner withdrew consent with this.
  interaction_required: "invalid_grant",
  invalid_client: "invalid_client",
  unauthorized_client: "unauthorized_client",
  authorization_pending: "pending",
  slow_down: "slow_down",
  expired_token: "expired",
  authorization_declined: "declined",
  access_denied: "declined",
  bad_verification_code: "invalid_grant",
};

export const parseTokenReply = (response: OAuthFormResponse): TokenReply => {
  const body = record(response.body);
  const accessToken = text(body["access_token"]);
  if (response.status >= 200 && response.status < 300 && accessToken !== null) {
    const refresh = text(body["refresh_token"]);
    const expires = body["expires_in"];
    const scope = text(body["scope"]);
    return {
      _tag: "granted",
      grant: {
        accessToken: Redacted.make(accessToken),
        refreshToken: refresh === null ? null : Redacted.make(refresh),
        expiresInSec: typeof expires === "number" && expires > 0 ? expires : 3_600,
        scopes: scope === null ? [] : scope.split(" "),
      },
    };
  }
  const error = text(body["error"]);
  const description = text(body["error_description"]);
  return {
    _tag: "refused",
    kind: (error !== null ? REFUSALS[error] : undefined) ?? "other",
    description: (description ?? error ?? `HTTP ${response.status}`).slice(0, 300),
  };
};

export interface DeviceCodeStart {
  readonly deviceCode: Redacted.Redacted<string>;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSec: number;
  readonly intervalSec: number;
}

export const parseDeviceCodeReply = (
  response: OAuthFormResponse,
):
  | { readonly _tag: "started"; readonly start: DeviceCodeStart }
  | Extract<TokenReply, { _tag: "refused" }> => {
  const body = record(response.body);
  const deviceCode = text(body["device_code"]);
  const userCode = text(body["user_code"]);
  const uri = text(body["verification_uri"]);
  if (response.status >= 200 && response.status < 300 && deviceCode && userCode && uri) {
    const expires = body["expires_in"];
    const interval = body["interval"];
    return {
      _tag: "started",
      start: {
        deviceCode: Redacted.make(deviceCode),
        userCode,
        verificationUri: uri,
        expiresInSec: typeof expires === "number" && expires > 0 ? expires : 900,
        intervalSec: typeof interval === "number" && interval > 0 ? interval : 5,
      },
    };
  }
  const refused = parseTokenReply({ status: response.status, body: response.body });
  return refused._tag === "refused"
    ? refused
    : { _tag: "refused", kind: "other", description: "Unexpected reply from Microsoft." };
};

const GOOGLE_CLIENT_ID = /^\d{6,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com$/i;
const GOOGLE_CLIENT_SECRET = /^[A-Za-z0-9_-]{20,80}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ShapeProblem = string | null;

export const googleClientShapeProblem = (id: string, secret: string): ShapeProblem => {
  if (!GOOGLE_CLIENT_ID.test(id)) {
    return "That does not look like a Google client ID. It ends in .apps.googleusercontent.com.";
  }
  if (!GOOGLE_CLIENT_SECRET.test(secret)) {
    return "That does not look like a Google client secret. It is one line of letters, digits, dashes and underscores, usually starting GOCSPX-.";
  }
  return null;
};

export const microsoftClientShapeProblem = (id: string): ShapeProblem =>
  GUID.test(id)
    ? null
    : "That does not look like an Application (client) ID. It is 32 letters and digits in groups, like 11111111-2222-3333-4444-555555555555.";
