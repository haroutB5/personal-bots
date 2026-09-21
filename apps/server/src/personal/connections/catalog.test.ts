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
      },
      vercel: {
        vendorId: "vercel",
        displayName: "Vercel",
        authKind: "token-paste",
        requiredCredentialFields: ["accessToken"],
        tokenPageUrl: "https://vercel.com/account/settings/tokens",
        requiredScopes: [],
      },
      neon: {
        vendorId: "neon",
        displayName: "Neon",
        authKind: "token-paste",
        requiredCredentialFields: ["apiKey"],
        tokenPageUrl: "https://console.neon.tech/app/settings/api-keys",
        requiredScopes: [],
      },
      upstash: {
        vendorId: "upstash",
        displayName: "Upstash",
        authKind: "token-paste",
        requiredCredentialFields: ["email", "apiKey"],
        tokenPageUrl: "https://console.upstash.com/account/api",
        requiredScopes: [],
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
      },
    });

    for (const definition of Object.values(PERSONAL_CONNECTION_CATALOG)) {
      expect(definition).not.toHaveProperty("operations");
      expect(definition).not.toHaveProperty("risk");
    }
  });
});
