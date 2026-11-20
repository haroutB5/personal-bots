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

export function emailView(
  status: PersonalEmailStatus | null,
  connections: ReadonlyArray<PersonalConnection>,
  failure: string | null,
): EmailView {
  if (status === null) {
    return failure === null ? { kind: "loading" } : { kind: "unreachable", message: failure };
  }
  const thunderbird = status.thunderbird;
  switch (thunderbird._tag) {
    case "closed":
      return { kind: "closed" };
    case "addon-missing":
      return { kind: "repair", line: REPAIR_LINES["addon-missing"] };
    case "unsupported":
      return { kind: "repair", line: thunderbird.reason };
    case "ready": {
      if (thunderbird.accounts.length === 0) return { kind: "no-accounts" };
      const connected = new Set(
        connections
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

export const thunderbirdLine = (status: PersonalEmailStatus | null): string => {
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
