import { describe, expect, it } from "@effect/vitest";

import { PERSONAL_CONNECTION_CATALOG } from "./catalog.ts";

describe("personal connection catalog", () => {
  it("defines only Milestone 1 authentication metadata for every vendor", () => {
    expect(PERSONAL_CONNECTION_CATALOG).toEqual({
      github: {
        vendorId: "github",
        displayName: "GitHub",
        authKind: "device-flow",
        requiredCredentialFields: ["accessToken"],
        tokenPageUrl: "https://github.com/login/device",
      },
      vercel: {
        vendorId: "vercel",
        displayName: "Vercel",
        authKind: "token-paste",
        requiredCredentialFields: ["accessToken"],
        tokenPageUrl: "https://vercel.com/account/settings/tokens",
      },
      neon: {
        vendorId: "neon",
        displayName: "Neon",
        authKind: "token-paste",
        requiredCredentialFields: ["apiKey"],
        tokenPageUrl: "https://console.neon.tech/app/settings/api-keys",
      },
      upstash: {
        vendorId: "upstash",
        displayName: "Upstash",
        authKind: "token-paste",
        requiredCredentialFields: ["email", "apiKey"],
        tokenPageUrl: "https://console.upstash.com/account/api",
      },
    });

    for (const definition of Object.values(PERSONAL_CONNECTION_CATALOG)) {
      expect(definition).not.toHaveProperty("operations");
      expect(definition).not.toHaveProperty("risk");
    }
  });
});
