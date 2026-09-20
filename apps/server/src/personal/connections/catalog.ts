import type { PersonalConnectionVendorId } from "@t3tools/contracts";

export interface PersonalConnectionDefinition {
  readonly vendorId: PersonalConnectionVendorId;
  readonly displayName: string;
  readonly authKind: "device-flow" | "token-paste";
  readonly requiredCredentialFields: ReadonlyArray<string>;
  readonly tokenPageUrl: string;
}

export const PERSONAL_CONNECTION_CATALOG = {
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
} as const satisfies Record<PersonalConnectionVendorId, PersonalConnectionDefinition>;

export const connectionDefinition = (vendor: PersonalConnectionVendorId) =>
  PERSONAL_CONNECTION_CATALOG[vendor];
