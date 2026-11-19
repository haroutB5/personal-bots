export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

export type GoogleAuthResult =
  | {
      readonly status: "granted";
      readonly serverAuthCode: string;
      readonly grantedScopes: ReadonlyArray<string>;
    }
  | { readonly status: "scopes_denied"; readonly missing: ReadonlyArray<string> }
  | { readonly status: "no_code" }
  | { readonly status: "cancelled" }
  | { readonly status: "unavailable" }
  | { readonly status: "error"; readonly code: number; readonly message: string };

export interface SigningIdentity {
  readonly packageName: string;
  readonly sha1: string;
  readonly sha256: string;
}

export interface GoogleAuthModule {
  authorize(serverClientId: string, scopes: ReadonlyArray<string>): Promise<unknown>;
  signingIdentity(): unknown;
}

export interface GoogleAuthPort {
  readonly authorize: (serverClientId: string) => Promise<GoogleAuthResult>;
  readonly signingIdentity: () => SigningIdentity | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** The native side answers with a plain map. Anything that is not one of its shapes is an error, never a grant. */
export function parseGoogleAuthResult(raw: unknown): GoogleAuthResult {
  if (!isRecord(raw)) {
    return { status: "error", code: -1, message: "Google sign-in returned nothing." };
  }
  switch (raw["status"]) {
    case "granted": {
      const code = raw["serverAuthCode"];
      return typeof code === "string" && code.length > 0
        ? { status: "granted", serverAuthCode: code, grantedScopes: strings(raw["grantedScopes"]) }
        : { status: "no_code" };
    }
    case "scopes_denied":
      return { status: "scopes_denied", missing: strings(raw["missing"]) };
    case "no_code":
      return { status: "no_code" };
    case "cancelled":
      return { status: "cancelled" };
    case "error":
      return {
        status: "error",
        code: typeof raw["code"] === "number" ? raw["code"] : -1,
        message: typeof raw["message"] === "string" ? raw["message"] : "Google sign-in failed.",
      };
    default:
      return { status: "error", code: -1, message: "Google sign-in returned an unknown answer." };
  }
}

export function parseSigningIdentity(raw: unknown): SigningIdentity | null {
  if (!isRecord(raw)) return null;
  const { packageName, sha1, sha256 } = raw;
  return typeof packageName === "string" && typeof sha1 === "string" && typeof sha256 === "string"
    ? { packageName, sha1, sha256 }
    : null;
}

export const makeGoogleAuthPort = (native: GoogleAuthModule | null): GoogleAuthPort => ({
  authorize: async (serverClientId) => {
    if (native === null) return { status: "unavailable" };
    try {
      return parseGoogleAuthResult(await native.authorize(serverClientId, GMAIL_SCOPES));
    } catch (error) {
      return {
        status: "error",
        code: -1,
        message: error instanceof Error ? error.message : "Google sign-in failed.",
      };
    }
  },
  signingIdentity: () => (native === null ? null : parseSigningIdentity(native.signingIdentity())),
});
