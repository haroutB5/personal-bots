import type { PersonalConnectionVendorId } from "@t3tools/contracts";

export interface PersonalConnectionDefinition {
  readonly vendorId: PersonalConnectionVendorId;
  readonly displayName: string;
  /**
   * Every vendor is a paste. GitHub could do a device flow, but that needs an
   * OAuth app registered under an account we do not own, and a beginner minting
   * a token is already on the site creating the account anyway. Owner decision,
   * 2026-09-20.
   */
  readonly authKind: "token-paste";
  readonly requiredCredentialFields: ReadonlyArray<string>;
  readonly tokenPageUrl: string;
  /** Named on the connect screen and checked at validation, so a short token fails before a task does. */
  readonly requiredScopes: ReadonlyArray<string>;
}

export const PERSONAL_CONNECTION_CATALOG = {
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
} as const satisfies Record<PersonalConnectionVendorId, PersonalConnectionDefinition>;

export const connectionDefinition = (vendor: PersonalConnectionVendorId) =>
  PERSONAL_CONNECTION_CATALOG[vendor];
