import { describe, expect, it } from "@effect/vitest";

import { PERSONAL_CONNECTION_CATALOG } from "./catalog.ts";

describe("personal connection catalog", () => {
  it("defines how every vendor authenticates, and nothing about its operations", () => {
    expect(PERSONAL_CONNECTION_CATALOG).toEqual({
      github: {
        vendorId: "github",
        displayName: "GitHub",
        authKind: "token-paste",
        requiredCredentialFields: ["accessToken"],
        tokenPageUrl: "https://github.com/settings/tokens/new",
        requiredScopes: ["repo", "workflow"],
        multiAccount: false,
      },
      vercel: {
        vendorId: "vercel",
        displayName: "Vercel",
        authKind: "token-paste",
        requiredCredentialFields: ["accessToken"],
        tokenPageUrl: "https://vercel.com/account/settings/tokens",
        requiredScopes: [],
        multiAccount: false,
      },
      neon: {
        vendorId: "neon",
        displayName: "Neon",
        authKind: "token-paste",
        requiredCredentialFields: ["apiKey"],
        tokenPageUrl: "https://console.neon.tech/app/settings/api-keys",
        requiredScopes: [],
        multiAccount: false,
      },
      upstash: {
        vendorId: "upstash",
        displayName: "Upstash",
        authKind: "token-paste",
        requiredCredentialFields: ["email", "apiKey"],
        tokenPageUrl: "https://console.upstash.com/account/api",
        requiredScopes: [],
        multiAccount: false,
      },
      // The one vendor with no token to paste: a personal WhatsApp account is
      // reached through a browser session the owner opens by scanning a QR,
      // so there is no credential for this feature to hold.
      whatsapp: {
        vendorId: "whatsapp",
        displayName: "WhatsApp",
        authKind: "browser-session",
        requiredCredentialFields: [],
        tokenPageUrl: "https://web.whatsapp.com/",
        requiredScopes: [],
        multiAccount: false,
      },
      gmail: {
        vendorId: "gmail",
        displayName: "Gmail",
        authKind: "oauth",
        requiredCredentialFields: ["refreshToken"],
        tokenPageUrl: "https://mail.google.com/",
        requiredScopes: [],
        multiAccount: true,
        oauth: {
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          revokeUrl: "https://oauth2.googleapis.com/revoke",
          scopes: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.compose",
          ],
          needsClientSecret: true,
          manageAccessUrl: "https://myaccount.google.com/permissions",
        },
      },
      outlook: {
        vendorId: "outlook",
        displayName: "Outlook",
        authKind: "oauth",
        requiredCredentialFields: ["refreshToken"],
        tokenPageUrl: "https://outlook.live.com/mail/",
        requiredScopes: [],
        multiAccount: true,
        oauth: {
          authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
          tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          revokeUrl: null,
          scopes: ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"],
          needsClientSecret: false,
          manageAccessUrl: "https://account.live.com/consent/Manage",
        },
      },
    });

    for (const definition of Object.values(PERSONAL_CONNECTION_CATALOG)) {
      expect(definition).not.toHaveProperty("operations");
      expect(definition).not.toHaveProperty("risk");
    }
  });
});
