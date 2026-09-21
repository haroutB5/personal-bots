import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  ConnectionId,
  PersonalConnection,
  PersonalConnectionConnectInput,
  PersonalConnectionListResult,
} from "./personalConnections.ts";

const TOKEN = "fake-connection-token-that-must-not-leak";

describe("personal connection contracts", () => {
  it("decodes credential fields as redacted values", () => {
    const input = Schema.decodeUnknownSync(PersonalConnectionConnectInput)({
      vendorId: "github",
      credentials: { accessToken: TOKEN },
    });

    expect(Redacted.value(input.credentials.accessToken!)).toBe(TOKEN);
    expect(String(input.credentials.accessToken)).not.toContain(TOKEN);
  });

  it("serializes client-visible records without credential material", () => {
    const connection = PersonalConnection.make({
      connectionId: ConnectionId.make("connection-1"),
      vendorId: "github",
      status: "connected",
      account: {
        accountId: "account-1",
        accountName: "octocat",
        teamId: null,
        teamName: null,
      },
      verifiedCapabilities: ["repository:write"],
      settings: { whatsappDailySendCap: null },
      credentialVersion: 2,
      lastValidatedAt: DateTime.makeUnsafe("2026-09-20T12:00:00.000Z"),
      createdAt: DateTime.makeUnsafe("2026-09-20T10:00:00.000Z"),
      updatedAt: DateTime.makeUnsafe("2026-09-20T12:00:00.000Z"),
    });
    const encoded = Schema.encodeSync(Schema.fromJsonString(PersonalConnectionListResult))({
      connections: [connection],
    });

    expect(encoded).not.toContain("credentialRef");
    expect(encoded).not.toContain("credentials");
    expect(encoded).not.toContain(TOKEN);
  });
});
