import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { PERSONAL_CONNECTION_CATALOG } from "../catalog.ts";

export interface EmailOAuthEndpointSet {
  readonly google: {
    readonly tokenUrl: string;
    readonly profileUrl: string;
    readonly revokeUrl: string;
  };
  readonly microsoft: {
    readonly deviceCodeUrl: string;
    readonly tokenUrl: string;
    readonly profileUrl: string;
  };
}

/** Test-only: point the sign-in calls at a local stand-in. Unset in production. */
export const OAUTH_ENDPOINT_ENV = {
  googleToken: "HBOTS_TEST_EMAIL_GOOGLE_TOKEN_URL",
  googleProfile: "HBOTS_TEST_EMAIL_GOOGLE_PROFILE_URL",
  microsoftDeviceCode: "HBOTS_TEST_EMAIL_MICROSOFT_DEVICECODE_URL",
  microsoftToken: "HBOTS_TEST_EMAIL_MICROSOFT_TOKEN_URL",
  microsoftProfile: "HBOTS_TEST_EMAIL_MICROSOFT_PROFILE_URL",
} as const;

export const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

const google = PERSONAL_CONNECTION_CATALOG.gmail.oauth;
const microsoft = PERSONAL_CONNECTION_CATALOG.outlook.oauth;

export const makeEndpoints = (
  env: Readonly<Record<string, string | undefined>>,
): EmailOAuthEndpointSet => {
  const pick = (name: string, fallback: string) => {
    const value = env[name];
    return value !== undefined && value.length > 0 ? value : fallback;
  };
  return {
    google: {
      tokenUrl: pick(OAUTH_ENDPOINT_ENV.googleToken, google.tokenUrl),
      profileUrl: pick(OAUTH_ENDPOINT_ENV.googleProfile, GMAIL_PROFILE_URL),
      revokeUrl: google.revokeUrl,
    },
    microsoft: {
      deviceCodeUrl: pick(OAUTH_ENDPOINT_ENV.microsoftDeviceCode, microsoft.deviceCodeUrl),
      tokenUrl: pick(OAUTH_ENDPOINT_ENV.microsoftToken, microsoft.tokenUrl),
      profileUrl: pick(OAUTH_ENDPOINT_ENV.microsoftProfile, microsoft.profileUrl),
    },
  };
};

export class EmailOAuthEndpoints extends Context.Service<
  EmailOAuthEndpoints,
  EmailOAuthEndpointSet
>()("t3/personal/connections/email/oauthEndpoints/EmailOAuthEndpoints") {}

export const layerFrom = (set: EmailOAuthEndpointSet) => Layer.succeed(EmailOAuthEndpoints, set);
export const layer = layerFrom(makeEndpoints(process.env));
