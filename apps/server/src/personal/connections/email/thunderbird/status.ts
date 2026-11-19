import type { EmailVendorId } from "@t3tools/contracts";

export type ThunderbirdServerType = "imap" | "ews" | "graph" | "pop3";

export interface ThunderbirdAccount {
  readonly accountId: string;
  readonly address: string;
  readonly vendor: EmailVendorId;
  readonly serverType: ThunderbirdServerType;
}

export type ThunderbirdStatus =
  | { readonly _tag: "ready"; readonly accounts: ReadonlyArray<ThunderbirdAccount> }
  | { readonly _tag: "closed" }
  | { readonly _tag: "addon-missing" }
  | { readonly _tag: "unsupported"; readonly reason: string };

export const THUNDERBIRD_CLOSED_LINE =
  "Thunderbird is not running on the laptop. Ask Harout to open it.";
export const THUNDERBIRD_ADDON_LINE =
  "Thunderbird is open but its mail add-on is not answering. Ask Harout to check it.";

const SERVER_TYPES: ReadonlySet<string> = new Set(["imap", "ews", "graph", "pop3"]);

export const vendorOfAddress = (address: string): EmailVendorId | null => {
  const domain = address.toLowerCase().split("@")[1] ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") return "gmail";
  return /^(outlook|live|hotmail|msn)\.[a-z]{2,}(\.[a-z]{2,})?$/.test(domain) ? "outlook" : null;
};

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

/**
 * Reads the add-on's `listAccounts` reply. An account that is not a mail
 * server this build can serve (Local Folders, feeds) or whose address is
 * neither Gmail nor Outlook is left out, not reported as broken.
 */
export const accountsFromList = (raw: unknown): ReadonlyArray<ThunderbirdAccount> => {
  const list = Array.isArray(raw) ? raw : [];
  return list.flatMap((entry): ReadonlyArray<ThunderbirdAccount> => {
    const account = record(entry);
    const accountId = account["id"];
    const type = account["type"];
    if (typeof accountId !== "string" || typeof type !== "string" || !SERVER_TYPES.has(type)) {
      return [];
    }
    const identities = Array.isArray(account["identities"])
      ? account["identities"].map(record)
      : [];
    const chosen = identities.find((identity) => identity["isDefault"] === true) ?? identities[0];
    const email = chosen?.["email"];
    if (typeof email !== "string") return [];
    const address = email.trim().toLowerCase();
    const vendor = vendorOfAddress(address);
    return vendor === null
      ? []
      : [{ accountId, address, vendor, serverType: type as ThunderbirdServerType }];
  });
};
