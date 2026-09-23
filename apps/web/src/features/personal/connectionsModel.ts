import { WHATSAPP_DEFAULT_DAILY_SEND_CAP } from "@t3tools/contracts";

import type {
  PersonalConnection,
  PersonalConnectionAuthKind,
  PersonalConnectionImportSource,
  PersonalConnectionVendorId,
} from "@t3tools/contracts";

/**
 * Everything the Connections screen decides, decided here.
 *
 * The screen renders; this says what each state means and which ways out of it
 * exist. The catalog is mirrored rather than imported from the server because
 * the client never runs server code, and the two are small enough that
 * duplication is cheaper than a new contract.
 */

export interface ConnectionVendorInfo {
  readonly vendorId: PersonalConnectionVendorId;
  readonly displayName: string;
  /**
   * Mirrors the server catalog. It decides which way in the row offers: a
   * paste field, or handing the owner the shared browser to sign in.
   */
  readonly authKind: PersonalConnectionAuthKind;
  readonly tokenPageUrl: string;
  readonly requiredScopes: ReadonlyArray<string>;
  readonly requiredCredentialFields: ReadonlyArray<string>;
  /** What the owner gets out of connecting it, in their words. */
  readonly purpose: string;
}

export const CONNECTION_VENDORS: ReadonlyArray<ConnectionVendorInfo> = [
  {
    vendorId: "github",
    authKind: "token-paste",
    displayName: "GitHub",
    tokenPageUrl: "https://github.com/settings/tokens/new",
    requiredScopes: ["repo", "workflow"],
    requiredCredentialFields: ["accessToken"],
    purpose: "Create repositories and push code.",
  },
  {
    vendorId: "vercel",
    authKind: "token-paste",
    displayName: "Vercel",
    tokenPageUrl: "https://vercel.com/account/settings/tokens",
    requiredScopes: [],
    requiredCredentialFields: ["accessToken"],
    purpose: "Create projects, set environment variables and deploy.",
  },
  {
    vendorId: "neon",
    authKind: "token-paste",
    displayName: "Neon",
    tokenPageUrl: "https://console.neon.tech/app/settings/api-keys",
    requiredScopes: [],
    requiredCredentialFields: ["apiKey"],
    purpose:
      "Create Postgres databases, and put their connection string straight into a Vercel project's environment without it passing through the chat.",
  },
  {
    vendorId: "upstash",
    authKind: "token-paste",
    displayName: "Upstash",
    tokenPageUrl: "https://console.upstash.com/account/api",
    requiredScopes: [],
    requiredCredentialFields: ["email", "apiKey"],
    purpose:
      "Create Redis databases, and put their REST credentials straight into a Vercel project's environment without them passing through the chat.",
  },
  {
    vendorId: "whatsapp",
    authKind: "browser-session",
    displayName: "WhatsApp",
    tokenPageUrl: "https://web.whatsapp.com/",
    requiredScopes: [],
    requiredCredentialFields: [],
    purpose:
      "Read your conversations and send messages from your own WhatsApp. You approve every message before it goes, and there is a daily limit.",
  },
];

export const vendorInfo = (vendorId: PersonalConnectionVendorId): ConnectionVendorInfo =>
  CONNECTION_VENDORS.find((vendor) => vendor.vendorId === vendorId) ?? CONNECTION_VENDORS[0]!;

export interface ConnectionRow {
  readonly vendorId: PersonalConnectionVendorId;
  readonly vendor: ConnectionVendorInfo;
  readonly connection: PersonalConnection | null;
}

/** Every vendor, in catalog order: an unconnected one still needs a way in. */
export const connectionRows = (
  connections: ReadonlyArray<PersonalConnection>,
): ReadonlyArray<ConnectionRow> =>
  CONNECTION_VENDORS.map((vendor) => ({
    vendorId: vendor.vendorId,
    vendor,
    connection: connections.find((row) => row.vendorId === vendor.vendorId) ?? null,
  }));

export type ConnectionTone = "ok" | "pending" | "attention" | "off";

export interface ConnectionDescription {
  readonly tone: ConnectionTone;
  /** The account line, or the state when there is no account to show. */
  readonly headline: string;
  readonly detail: string;
}

/** The cap in force, whether or not the owner has changed it. */
export const dailySendCap = (connection: PersonalConnection): number =>
  connection.settings?.whatsappDailySendCap ?? WHATSAPP_DEFAULT_DAILY_SEND_CAP;

export const describeConnection = (connection: PersonalConnection): ConnectionDescription => {
  const vendor = vendorInfo(connection.vendorId);
  if (connection.vendorId === "whatsapp") return describeWhatsApp(connection);
  const account =
    connection.account === null
      ? null
      : connection.account.teamName === null || connection.account.teamName.length === 0
        ? connection.account.accountName
        : `${connection.account.accountName} - ${connection.account.teamName}`;
  switch (connection.status) {
    case "connected":
      return {
        tone: "ok",
        headline: account ?? "Connected",
        detail: "Every bot can use this.",
      };
    case "connecting":
      return {
        tone: "pending",
        headline: account ?? "Not checked yet",
        detail: `hbots has not confirmed this ${vendor.displayName} token yet.`,
      };
    case "needs_reauth":
      return {
        tone: "attention",
        headline: account ?? "Needs a new token",
        // Expiry is the normal end of a personal access token, not a fault.
        detail: `${vendor.displayName} stopped accepting this token. Tokens expire; paste a new token to carry on.`,
      };
    case "disabled":
      return {
        tone: "off",
        headline: account ?? "Turned off",
        detail: "No bot can use this until you turn it back on.",
      };
    default:
      return {
        tone: "attention",
        headline: account ?? "Not working",
        detail: `hbots could not reach ${vendor.displayName} to check this. Try again, or paste a new token.`,
      };
  }
};

/**
 * WhatsApp reads differently from a token vendor in every state, so it gets
 * its own wording rather than a token sentence with the noun swapped. The two
 * facts the owner needs on the row are which number this is and how many
 * messages a day it may send.
 */
const describeWhatsApp = (connection: PersonalConnection): ConnectionDescription => {
  const number = connection.account?.accountId ?? null;
  const name = connection.account?.accountName ?? null;
  const headline =
    number === null ? "Not connected yet" : name === null ? number : `${name} - ${number}`;
  const cap = `Up to ${dailySendCap(connection)} messages a day, and you approve each one.`;
  switch (connection.status) {
    case "connected":
      return { tone: "ok", headline, detail: cap };
    case "connecting":
      return {
        tone: "pending",
        headline,
        detail: "Scan the code in the shared browser, then tap Check now.",
      };
    case "needs_reauth":
      // WhatsApp expires linked devices on its own schedule; this is routine.
      return {
        tone: "attention",
        headline,
        detail: "WhatsApp signed this device out. Scan the code again to carry on.",
      };
    case "disabled":
      return {
        tone: "off",
        headline,
        detail: "No bot can use WhatsApp until you turn it back on.",
      };
    default:
      return {
        tone: "attention",
        headline,
        detail: "hbots could not read WhatsApp Web. Scan the code again.",
      };
  }
};

export type ConnectionAction =
  | "connect"
  | "validate"
  | "reconnect"
  | "enable"
  | "disable"
  | "disconnect";

/**
 * Every state has its way out. Disabled offers enable rather than another
 * disable, and nothing is ever a one-way door.
 */
export const connectionActions = (
  connection: PersonalConnection | null,
): ReadonlyArray<ConnectionAction> => {
  if (connection === null) return ["connect"];
  switch (connection.status) {
    case "connected":
      return ["validate", "reconnect", "disable", "disconnect"];
    case "connecting":
      return ["validate", "reconnect", "disable", "disconnect"];
    case "disabled":
      return ["enable", "disconnect"];
    default:
      // Reconnect first: a refused token is replaced, not re-checked.
      return ["reconnect", "validate", "disconnect"];
  }
};

export const CONNECTION_ACTION_LABELS: Readonly<Record<ConnectionAction, string>> = {
  connect: "Connect",
  validate: "Check now",
  reconnect: "Paste a new token",
  enable: "Turn on",
  disable: "Turn off",
  disconnect: "Remove",
};

/** Only the way back in differs by auth kind; the rest of the labels do not. */
export const connectionActionLabel = (
  action: ConnectionAction,
  vendorId: PersonalConnectionVendorId,
): string => {
  if (vendorInfo(vendorId).authKind !== "browser-session") return CONNECTION_ACTION_LABELS[action];
  if (action === "reconnect") return "Scan the code again";
  if (action === "connect") return "Scan the QR code";
  return CONNECTION_ACTION_LABELS[action];
};

/**
 * What removing this connection actually costs, which is not the same thing
 * for a stored token and for a session hbots never held.
 */
export const disconnectWarning = (vendorId: PersonalConnectionVendorId): string => {
  const vendor = vendorInfo(vendorId);
  return vendor.authKind === "browser-session"
    ? `Remove ${vendor.displayName}?
No bot can use it and the daily limit is forgotten. Your phone stays linked and the browser is still signed in: unlink it in WhatsApp on your phone if that is what you want.`
    : `Remove ${vendor.displayName}?
The saved token is deleted and no bot can use this account.`;
};

/** Credential fields are wire names; the owner reads words. */
export const CONNECTION_FIELD_LABELS: Readonly<Record<string, string>> = {
  accessToken: "token",
  apiKey: "API key",
  email: "email",
};

export const fieldLabel = (field: string) => CONNECTION_FIELD_LABELS[field] ?? field;

export type TokenDraft = Readonly<Record<string, string>>;

export const emptyTokenDraft = (vendorId: PersonalConnectionVendorId): TokenDraft =>
  Object.fromEntries(vendorInfo(vendorId).requiredCredentialFields.map((field) => [field, ""]));

/**
 * The only check the client makes: that something was pasted. Whether a token
 * works is the server's call against the vendor, and guessing a shape here
 * would reject a valid token the day a provider changes its prefix.
 */
export const validateTokenDraft = (
  vendorId: PersonalConnectionVendorId,
  draft: TokenDraft,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    vendorInfo(vendorId)
      .requiredCredentialFields.filter((field) => (draft[field] ?? "").trim().length === 0)
      .map((field) => [field, `Paste the ${fieldLabel(field)} to connect.`]),
  );

export interface ImportSourceDescription {
  readonly tone: "muted" | "attention" | "ok";
  readonly text: string;
}

export const describeImportSource = (
  source: PersonalConnectionImportSource,
): ImportSourceDescription => {
  switch (source.state) {
    case "found":
      return { tone: "ok", text: source.detail ?? `${source.label} login found.` };
    case "absent":
      // Not a failure: most people do not have every CLI installed.
      return { tone: "muted", text: source.detail ?? `No ${source.label} login on this machine.` };
    default:
      return {
        tone: "attention",
        text: source.detail ?? `The ${source.label} file is there but could not be read.`,
      };
  }
};

/**
 * What a rejected token says on screen. The server passes the vendor's own
 * reply through ("GitHub did not accept this token: HTTP 401:
 * {"message":"Bad credentials","documentation_url":"https://docs.github.c…"),
 * which read as a crash and ran an unbroken URL off the card. An auth refusal
 * becomes a plain sentence; anything else is kept, since it may be the only
 * clue to what went wrong.
 */
export function friendlyTokenFailure(vendorName: string, message: string): string {
  if (/\bHTTP 401\b|bad credentials|unauthori[sz]ed/i.test(message)) {
    return `${vendorName} rejected this token. Check it was copied whole and has not expired.`;
  }
  if (/\bHTTP 403\b|forbidden/i.test(message)) {
    return `${vendorName} accepted this token but refused access. Check the token has the permissions listed above.`;
  }
  return message;
}
