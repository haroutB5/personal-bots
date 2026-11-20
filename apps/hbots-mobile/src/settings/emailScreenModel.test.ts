import type { PersonalConnection, PersonalEmailStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canUseAccounts, emailView, profileSizeLabel, thunderbirdLine } from "./emailScreenModel";

const account = (
  accountId: string,
  address: string,
  vendor: "gmail" | "outlook",
  serverType: "imap" | "ews" = "imap",
) => ({ accountId, address, vendor, serverType });

const ready = (
  accounts: ReadonlyArray<ReturnType<typeof account>>,
  accountsConfirmed = false,
): PersonalEmailStatus => ({
  thunderbird: { _tag: "ready", accounts },
  accountsConfirmed,
  profileSizeBytes: null,
});

const connection = (vendorId: "gmail" | "outlook", address: string, status = "connected") =>
  ({ vendorId, status, account: { accountId: address } }) as unknown as PersonalConnection;

describe("emailView", () => {
  it("is loading until the first answer, and unreachable when none can come", () => {
    expect(emailView(null, [], null)).toEqual({ kind: "loading" });
    expect(emailView(null, [], "Not connected to your computer.")).toEqual({
      kind: "unreachable",
      message: "Not connected to your computer.",
    });
  });

  it("shows closed and repair states without any account", () => {
    const closed: PersonalEmailStatus = {
      thunderbird: { _tag: "closed" },
      accountsConfirmed: true,
      profileSizeBytes: 10,
    };
    expect(emailView(closed, [], null)).toEqual({ kind: "closed" });
    expect(
      emailView(
        { ...closed, thunderbird: { _tag: "unsupported", reason: "The bridge is old." } },
        [],
        null,
      ),
    ).toEqual({ kind: "repair", line: "The bridge is old." });
    expect(emailView({ ...closed, thunderbird: { _tag: "addon-missing" } }, [], null).kind).toBe(
      "repair",
    );
  });

  it("is not set up when Thunderbird is ready with no mail accounts", () => {
    expect(emailView(ready([]), [], null)).toEqual({ kind: "no-accounts" });
  });

  it("marks found, not-imap and connected accounts, and offers only the usable ones", () => {
    const status = ready(
      [
        account("account1", "a@gmail.com", "gmail"),
        account("account2", "b@live.com", "outlook"),
        account("account3", "c@outlook.com", "outlook", "ews"),
      ],
      false,
    );
    const view = emailView(status, [], null);
    expect(view).toMatchObject({
      kind: "accounts",
      rows: [
        { address: "a@gmail.com", state: "found" },
        { address: "b@live.com", state: "found" },
        { address: "c@outlook.com", state: "not-imap" },
      ],
      useIds: ["account1", "account2"],
    });
    expect(canUseAccounts(view)).toBe(true);
  });

  it("shows connected only once the allowlist is written and a connected row exists", () => {
    const accounts = [account("account1", "a@gmail.com", "gmail")];
    const rows = [connection("gmail", "a@gmail.com")];
    expect(emailView(ready(accounts, false), rows, null)).toMatchObject({
      rows: [{ state: "found" }],
    });
    const settled = emailView(ready(accounts, true), rows, null);
    expect(settled).toMatchObject({ rows: [{ state: "connected" }] });
    expect(canUseAccounts(settled)).toBe(false);
    expect(
      emailView(ready(accounts, true), [connection("gmail", "a@gmail.com", "disabled")], null),
    ).toMatchObject({
      rows: [{ state: "found" }],
    });
  });

  it("waits for the connection rows instead of showing confirmed accounts as found", () => {
    const accounts = [account("account1", "a@gmail.com", "gmail")];
    expect(emailView(ready(accounts, true), null, null)).toEqual({ kind: "loading" });
    expect(emailView(ready(accounts, false), null, null)).toMatchObject({
      kind: "accounts",
      rows: [{ state: "found" }],
    });
  });

  it("shows an error, not the last good answer, when a refresh fails", () => {
    const accounts = [account("account1", "a@gmail.com", "gmail")];
    const rows = [connection("gmail", "a@gmail.com")];
    expect(emailView(ready(accounts, true), rows, "The environment request failed.")).toEqual({
      kind: "unreachable",
      message: "The environment request failed.",
    });
  });

  it("offers no button for a ready Thunderbird whose only account is not IMAP", () => {
    const view = emailView(ready([account("account1", "a@live.com", "outlook", "ews")]), [], null);
    expect(canUseAccounts(view)).toBe(false);
  });
});

describe("labels", () => {
  it("names the Thunderbird state", () => {
    expect(thunderbirdLine(null, null)).toBe("Checking");
    expect(thunderbirdLine(ready([]), null)).toBe("Running");
    expect(thunderbirdLine(ready([]), "Not connected to your computer.")).toBe("Not reachable");
  });

  it("writes the profile size in the unit a person reads", () => {
    expect(profileSizeLabel(null)).toBeNull();
    expect(profileSizeLabel(400)).toBe("1 KB");
    expect(profileSizeLabel(25_000_000)).toBe("25 MB");
    expect(profileSizeLabel(1_234_000_000)).toBe("1.2 GB");
  });
});
