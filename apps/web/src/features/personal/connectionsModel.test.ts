import { describe, expect, it } from "vite-plus/test";

import { WHATSAPP_DEFAULT_DAILY_SEND_CAP } from "@t3tools/contracts";

import {
  CONNECTION_VENDORS,
  connectionActionLabel,
  connectionActions,
  disconnectWarning,
  connectionRows,
  describeConnection,
  describeImportSource,
  emptyTokenDraft,
  validateTokenDraft,
  vendorInfo,
} from "./connectionsModel";

import type { PersonalConnection } from "@t3tools/contracts";

const connection = (
  patch: Partial<PersonalConnection> & Pick<PersonalConnection, "vendorId" | "status">,
): PersonalConnection =>
  ({
    connectionId: "connection-1",
    account: null,
    verifiedCapabilities: [],
    credentialVersion: 1,
    lastValidatedAt: null,
    createdAt: null,
    updatedAt: null,
    ...patch,
  }) as unknown as PersonalConnection;

describe("connection rows", () => {
  it("lists every catalog vendor, connected or not", () => {
    const rows = connectionRows([connection({ vendorId: "vercel", status: "connected" })]);
    expect(rows.map((row) => row.vendorId)).toEqual(CONNECTION_VENDORS.map((v) => v.vendorId));
    expect(rows.find((row) => row.vendorId === "vercel")?.connection?.status).toBe("connected");
    // A vendor with no connection is still offered: the way in has to be
    // visible before there is anything to see.
    expect(rows.find((row) => row.vendorId === "github")?.connection).toBeNull();
  });
});

describe("connection status wording", () => {
  it("names the account and the team a connected vendor resolved to", () => {
    const described = describeConnection(
      connection({
        vendorId: "vercel",
        status: "connected",
        account: {
          accountId: "u1",
          accountName: "harout",
          teamId: "team_abc",
          teamName: "Harout Projects",
        },
      }),
    );
    expect(described.tone).toBe("ok");
    expect(described.headline).toBe("harout - Harout Projects");
  });

  it("falls back to the account when there is no team, not to an empty dash", () => {
    const described = describeConnection(
      connection({
        vendorId: "github",
        status: "connected",
        account: {
          accountId: "42",
          accountName: "haroutB5",
          teamId: null,
          teamName: null,
        },
      }),
    );
    expect(described.headline).toBe("haroutB5");
  });

  it("tells the owner what to do about a token the vendor stopped accepting", () => {
    const described = describeConnection(
      connection({ vendorId: "github", status: "needs_reauth" }),
    );
    expect(described.tone).toBe("attention");
    // The expiry is normal and the instruction is concrete, not "an error occurred".
    expect(described.detail).toContain("new token");
  });

  it("distinguishes disabled from broken", () => {
    expect(describeConnection(connection({ vendorId: "github", status: "disabled" })).tone).toBe(
      "off",
    );
    expect(describeConnection(connection({ vendorId: "github", status: "error" })).tone).toBe(
      "attention",
    );
    expect(describeConnection(connection({ vendorId: "neon", status: "connecting" })).tone).toBe(
      "pending",
    );
  });
});

describe("connection actions", () => {
  it("offers connect and nothing else before there is a connection", () => {
    expect(connectionActions(null)).toEqual(["connect"]);
  });

  it("offers the way out of every state it can put a connection into", () => {
    expect(connectionActions(connection({ vendorId: "github", status: "connected" }))).toEqual([
      "validate",
      "reconnect",
      "disable",
      "disconnect",
    ]);
    // Disabled needs enable, not another disable: a one-way door is a bug.
    expect(connectionActions(connection({ vendorId: "github", status: "disabled" }))).toEqual([
      "enable",
      "disconnect",
    ]);
    expect(connectionActions(connection({ vendorId: "github", status: "needs_reauth" }))).toEqual([
      "reconnect",
      "validate",
      "disconnect",
    ]);
  });
});

describe("token draft", () => {
  it("refuses an empty paste before it reaches the server", () => {
    expect(validateTokenDraft("github", emptyTokenDraft("github"))).toEqual({
      accessToken: "Paste the token to connect.",
    });
  });

  it("accepts a token with surrounding whitespace, which a copy usually has", () => {
    expect(validateTokenDraft("github", { accessToken: "  ghp_abc  " })).toEqual({});
  });

  it("asks for every field a vendor needs, by name", () => {
    expect(validateTokenDraft("upstash", { email: "", apiKey: "" })).toEqual({
      email: "Paste the email to connect.",
      apiKey: "Paste the API key to connect.",
    });
  });
});

describe("what each vendor is for", () => {
  it("says what every catalog vendor does, with none of them unwired", () => {
    for (const vendor of CONNECTION_VENDORS) {
      expect(vendor.purpose.length, vendor.vendorId).toBeGreaterThan(0);
      // Neon and Upstash said "Not wired up yet" while they had no adapter.
      // They have one now, and a screen that still says so is a screen telling
      // the owner not to bother connecting something that works.
      expect(vendor.purpose, vendor.vendorId).not.toContain("Not wired up");
    }
  });

  it("names the database work a bot can now actually do", () => {
    expect(vendorInfo("neon").purpose).toContain("Postgres");
    expect(vendorInfo("upstash").purpose).toContain("Redis");
    // The point of the milestone, said where the owner decides to connect.
    expect(vendorInfo("neon").purpose).toContain("Vercel");
    expect(vendorInfo("upstash").purpose).toContain("Vercel");
  });
});

describe("import sources", () => {
  it("says nothing was found without calling it a failure", () => {
    const described = describeImportSource({
      sourceId: "gh-cli",
      vendorId: "github",
      label: "GitHub CLI",
      state: "absent",
      detail: "No GitHub CLI login on this machine.",
    });
    expect(described.tone).toBe("muted");
    expect(described.text).toBe("No GitHub CLI login on this machine.");
  });

  it("calls a file it could not read a failure, which is a different thing", () => {
    const described = describeImportSource({
      sourceId: "vercel-cli",
      vendorId: "vercel",
      label: "Vercel CLI",
      state: "unreadable",
      detail: null,
    });
    expect(described.tone).toBe("attention");
    expect(described.text).toContain("Vercel CLI");
  });
});

describe("whatsapp, which is signed into rather than pasted", () => {
  it("offers the QR rather than a token field, in every state that needs a way in", () => {
    expect(vendorInfo("whatsapp").authKind).toBe("browser-session");
    expect(vendorInfo("whatsapp").requiredCredentialFields).toEqual([]);

    expect(connectionActions(null)).toEqual(["connect"]);
    // "Paste a new token" is meaningless here: reconnecting is scanning again.
    expect(connectionActions(connection({ vendorId: "whatsapp", status: "needs_reauth" }))).toEqual(
      ["reconnect", "validate", "disconnect"],
    );
    expect(connectionActionLabel("reconnect", "whatsapp")).toBe("Scan the code again");
    expect(connectionActionLabel("reconnect", "github")).toBe("Paste a new token");
  });

  it("shows the number it is connected as, and the send cap, on the row", () => {
    const described = describeConnection(
      connection({
        vendorId: "whatsapp",
        status: "connected",
        account: {
          accountId: "+447700900000",
          accountName: "Harout",
          teamId: null,
          teamName: null,
        },
        settings: { whatsappDailySendCap: 4 },
      }),
    );
    expect(described.headline).toContain("+447700900000");
    expect(described.detail).toContain("4");
  });

  it("names the default cap when the owner has not set one", () => {
    const described = describeConnection(
      connection({
        vendorId: "whatsapp",
        status: "connected",
        settings: { whatsappDailySendCap: null },
      }),
    );
    expect(described.detail).toContain(String(WHATSAPP_DEFAULT_DAILY_SEND_CAP));
  });

  it("says a removed WhatsApp is still signed in, because removing it does not sign out", () => {
    expect(disconnectWarning("whatsapp")).toContain("still signed in");
    expect(disconnectWarning("github")).toContain("token");
  });
});
