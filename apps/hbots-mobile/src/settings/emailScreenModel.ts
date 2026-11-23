import type { PersonalConnection, PersonalEmailStatus } from "@t3tools/contracts";

export type EmailAccountState = "connected" | "found" | "not-imap";

export interface EmailAccountRow {
  readonly accountId: string;
  readonly address: string;
  readonly vendor: "gmail" | "outlook";
  readonly state: EmailAccountState;
}

/**
 * What the Email screen shows. One tag per screen state, so a button that only
 * makes sense in one state cannot be drawn in another.
 */
export type EmailView =
  | { readonly kind: "loading" }
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "closed" }
  | { readonly kind: "repair"; readonly line: string }
  | { readonly kind: "no-accounts" }
  | {
      readonly kind: "accounts";
      readonly rows: ReadonlyArray<EmailAccountRow>;
      readonly useIds: ReadonlyArray<string>;
    };

export const REPAIR_LINES = {
  "addon-missing": "Thunderbird is open but its mail add-on is not answering.",
} as const;

/**
 * The lines hbots itself writes for an `unsupported` status
 * (commonpostClient, bridgeChannel). They are already plain and are shown as
 * they are.
 */
const PLAIN_UNSUPPORTED_LINES: ReadonlySet<string> = new Set([
  "The Commonpost mail bridge is not installed on the laptop.",
  "The Commonpost mail bridge is not the version hbots was reviewed with.",
  "The add-on's tools differ from the version hbots was reviewed with.",
  "The mail bridge stopped before it answered.",
  "The mail bridge refused to start a session.",
  "The mail bridge failed.",
]);

export const UNSUPPORTED_LINES = {
  addonOld: "Thunderbird's mail add-on is out of date. Ask a bot to update it.",
  addonNotice: "Thunderbird's mail add-on needs attention on the laptop.",
  bridgeStart: "The mail bridge could not start on the laptop.",
  bridgeSlow: "The mail bridge took too long to answer. Try again in a minute.",
  cancelled: "The check was stopped before it finished. Try again.",
  noAnswer: "Thunderbird's mail add-on did not answer.",
  addonError: "Thunderbird's mail add-on reported an error.",
} as const;

/**
 * The `unsupported` reason in plain words (1.67.54 finding 6c). The reason can
 * be the add-on's own notice or raw error text, which never reaches the
 * screen: only hbots's own sentences pass through unchanged.
 */
export function unsupportedLine(reason: string): string {
  const text = reason.trim();
  if (PLAIN_UNSUPPORTED_LINES.has(text)) return text;
  if (/^Commonpost notice/i.test(text)) {
    return /older than|out of date|update/i.test(text)
      ? UNSUPPORTED_LINES.addonOld
      : UNSUPPORTED_LINES.addonNotice;
  }
  if (text.startsWith("Could not start the mail bridge")) return UNSUPPORTED_LINES.bridgeStart;
  if (/^The mail bridge did not answer .* in time\.$/.test(text))
    return UNSUPPORTED_LINES.bridgeSlow;
  if (text === "Cancelled.") return UNSUPPORTED_LINES.cancelled;
  if (text === "No answer.") return UNSUPPORTED_LINES.noAnswer;
  return UNSUPPORTED_LINES.addonError;
}

/**
 * A failed read wins over whatever an earlier read left behind, and a status
 * that says the accounts are confirmed waits for the connection rows, because
 * without them every account would flash as merely found.
 */
export function emailView(
  status: PersonalEmailStatus | null,
  connections: ReadonlyArray<PersonalConnection> | null,
  failure: string | null,
): EmailView {
  if (failure !== null) return { kind: "unreachable", message: failure };
  if (status === null) return { kind: "loading" };
  const thunderbird = status.thunderbird;
  switch (thunderbird._tag) {
    case "closed":
      return { kind: "closed" };
    case "addon-missing":
      return { kind: "repair", line: REPAIR_LINES["addon-missing"] };
    case "unsupported":
      return { kind: "repair", line: unsupportedLine(thunderbird.reason) };
    case "ready": {
      if (thunderbird.accounts.length === 0) return { kind: "no-accounts" };
      if (status.accountsConfirmed && connections === null) return { kind: "loading" };
      const connected = new Set(
        (connections ?? [])
          .filter((connection) => connection.status === "connected")
          .map((connection) => `${connection.vendorId}:${connection.account?.accountId ?? ""}`),
      );
      const rows = thunderbird.accounts.map((account): EmailAccountRow => {
        const isConnected =
          status.accountsConfirmed && connected.has(`${account.vendor}:${account.address}`);
        return {
          accountId: account.accountId,
          address: account.address,
          vendor: account.vendor,
          state: account.serverType !== "imap" ? "not-imap" : isConnected ? "connected" : "found",
        };
      });
      return {
        kind: "accounts",
        rows,
        useIds: rows.filter((row) => row.state !== "not-imap").map((row) => row.accountId),
      };
    }
  }
}

export const canUseAccounts = (view: EmailView): boolean =>
  view.kind === "accounts" && view.rows.some((row) => row.state === "found");

export const thunderbirdLine = (
  status: PersonalEmailStatus | null,
  failure: string | null,
): string => {
  if (failure !== null) return "Not reachable";
  if (status === null) return "Checking";
  switch (status.thunderbird._tag) {
    case "ready":
      return "Running";
    case "closed":
      return "Closed";
    case "addon-missing":
      return "Add-on not answering";
    case "unsupported":
      return "Needs attention";
  }
};

export const accountStateLabel: Readonly<Record<EmailAccountState, string>> = {
  connected: "Connected",
  found: "Found",
  "not-imap": "Not IMAP",
};

export function profileSizeLabel(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export const HOW_TO_ADD_STEPS: ReadonlyArray<string> = [
  "On the laptop, open Thunderbird and tap Add another account. Type the email address and continue.",
  "Your browser opens the provider's sign-in page. Pick the account and allow access.",
  "If Thunderbird offers Exchange or IMAP for a live.com or outlook.com address, choose IMAP. Then come back here.",
];

export const EMAIL_DRAFTS_NOTE = "Bots save drafts. You send them from your mail app.";
