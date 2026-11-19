import type {
  EmailVendorId,
  PersonalConnectionAuthKind,
  PersonalConnectionVendorId,
} from "@t3tools/contracts";

/** Where an OAuth vendor sends the owner to sign in and where tokens are exchanged. */
export interface PersonalConnectionOAuthDefinition {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  /** Best-effort revoke on disconnect; absent when the provider has none for this account type. */
  readonly revokeUrl: string | null;
  readonly scopes: ReadonlyArray<string>;
  /** Google's Desktop client has a secret; a Microsoft public client has none. */
  readonly needsClientSecret: boolean;
  /** The provider page where the owner can see and withdraw what they granted. */
  readonly manageAccessUrl: string;
}

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
  /** True when the owner can connect several accounts of this vendor, one mailbox per row. */
  readonly multiAccount: boolean;
  /** Present exactly when `authKind` is `oauth`. */
  readonly oauth?: PersonalConnectionOAuthDefinition;
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
    multiAccount: false,
  },
  gmail: {
    vendorId: "gmail",
    displayName: "Gmail",
    /**
     * Sign-in at Google, kept as a refresh token. The scopes are the narrowest
     * pair that lets a bot search and read (readonly) and prepare or send mail
     * (compose); neither can delete or change a message already in the box.
     */
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
    /**
     * Personal Microsoft accounts (live.com, outlook.com) and work accounts
     * through one public client with PKCE. There is no secret to keep, and
     * Microsoft has no per-token revoke for personal accounts, so disconnect
     * points the owner at the consent page instead.
     */
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
} as const satisfies Record<PersonalConnectionVendorId, PersonalConnectionDefinition>;

export const connectionDefinition = (vendor: PersonalConnectionVendorId) =>
  PERSONAL_CONNECTION_CATALOG[vendor];

/** Nothing is written to the credential store for these; there is no value. */
export const usesBrowserSession = (vendor: PersonalConnectionVendorId) =>
  connectionDefinition(vendor).authKind === "browser-session";

export const usesOAuth = (vendor: PersonalConnectionVendorId) =>
  connectionDefinition(vendor).authKind === "oauth";

/** The sign-in settings of a vendor that has them; the type says which vendors do. */
export const oauthDefinitionFor = (vendor: EmailVendorId): PersonalConnectionOAuthDefinition =>
  PERSONAL_CONNECTION_CATALOG[vendor].oauth;
