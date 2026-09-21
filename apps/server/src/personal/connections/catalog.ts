import type { PersonalConnectionAuthKind, PersonalConnectionVendorId } from "@t3tools/contracts";

export interface PersonalConnectionDefinition {
  readonly vendorId: PersonalConnectionVendorId;
  readonly displayName: string;
  /**
   * Declared per vendor, never defaulted. A vendor whose account has no token
   * must not fall into the paste flow by omission: `browser-session` means the
   * credential is the logged-in session in the shared browser profile and this
   * feature stores nothing at all.
   */
  readonly authKind: PersonalConnectionAuthKind;
  readonly requiredCredentialFields: ReadonlyArray<string>;
  /** Where the owner goes to get in. For a browser session, the site itself. */
  readonly tokenPageUrl: string;
  /** Named on the connect screen and checked at validation, so a short token fails before a task does. */
  readonly requiredScopes: ReadonlyArray<string>;
}

export const PERSONAL_CONNECTION_CATALOG = {
  github: {
    vendorId: "github",
    displayName: "GitHub",
    /**
     * GitHub could do a device flow, but that needs an OAuth app registered
     * under an account we do not own, and a beginner minting a token is
     * already on the site creating the account anyway. Owner decision,
     * 2026-09-20.
     */
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
  whatsapp: {
    vendorId: "whatsapp",
    displayName: "WhatsApp",
    /**
     * The owner's own WhatsApp account, by their decision on 2026-09-21, with
     * the risk to their personal number stated and accepted. There is no token
     * for a personal account, so there is nothing to paste and nothing to
     * store: the session lives in the shared browser profile on this machine,
     * exactly like every other saved login.
     */
    authKind: "browser-session",
    requiredCredentialFields: [],
    tokenPageUrl: "https://web.whatsapp.com/",
    requiredScopes: [],
  },
} as const satisfies Record<PersonalConnectionVendorId, PersonalConnectionDefinition>;

export const connectionDefinition = (vendor: PersonalConnectionVendorId) =>
  PERSONAL_CONNECTION_CATALOG[vendor];

/** Nothing is written to the credential store for these; there is no value. */
export const usesBrowserSession = (vendor: PersonalConnectionVendorId) =>
  connectionDefinition(vendor).authKind === "browser-session";
