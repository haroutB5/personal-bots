import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "@effect/vitest";

import {
  googleClientShapeProblem,
  microsoftClientShapeProblem,
  parseDeviceCodeReply,
  parseTokenReply,
} from "./oauthCore.ts";

describe("parseTokenReply", () => {
  it("reads a grant and keeps both tokens redacted", () => {
    const reply = parseTokenReply({
      status: 200,
      body: { access_token: "AT", refresh_token: "RT", expires_in: 3599, scope: "a b" },
    });
    if (reply._tag !== "granted") throw new Error("expected a grant");
    expect(Redacted.value(reply.grant.accessToken)).toBe("AT");
    expect(Redacted.value(reply.grant.refreshToken!)).toBe("RT");
    expect(reply.grant.expiresInSec).toBe(3599);
    expect(reply.grant.scopes).toEqual(["a", "b"]);
    expect(JSON.stringify(reply)).not.toContain("RT");
  });

  it("maps every provider refusal to the outcome the app acts on", () => {
    const kind = (error: string) => {
      const reply = parseTokenReply({ status: 400, body: { error } });
      return reply._tag === "refused" ? reply.kind : "granted";
    };
    expect(kind("invalid_grant")).toBe("invalid_grant");
    expect(kind("interaction_required")).toBe("invalid_grant");
    expect(kind("authorization_pending")).toBe("pending");
    expect(kind("slow_down")).toBe("slow_down");
    expect(kind("expired_token")).toBe("expired");
    expect(kind("authorization_declined")).toBe("declined");
    expect(kind("invalid_client")).toBe("invalid_client");
    expect(kind("something_new")).toBe("other");
  });

  it("never treats a 200 without an access token as a grant", () => {
    expect(parseTokenReply({ status: 200, body: {} })._tag).toBe("refused");
    expect(parseTokenReply({ status: 500, body: "<html>" })._tag).toBe("refused");
  });
});

describe("parseDeviceCodeReply", () => {
  it("reads the code the owner types and the deadline", () => {
    const reply = parseDeviceCodeReply({
      status: 200,
      body: {
        device_code: "DC",
        user_code: "ABCD1234",
        verification_uri: "https://www.microsoft.com/link",
        expires_in: 900,
        interval: 5,
      },
    });
    if (reply._tag !== "started") throw new Error("expected a start");
    expect(reply.start.userCode).toBe("ABCD1234");
    expect(Redacted.value(reply.start.deviceCode)).toBe("DC");
    expect(reply.start.intervalSec).toBe(5);
  });

  it("refuses a reply that lacks the user code", () => {
    expect(parseDeviceCodeReply({ status: 200, body: { device_code: "DC" } })._tag).toBe("refused");
  });
});

describe("client shape checks", () => {
  it("accepts a Google web client id and a GOCSPX secret", () => {
    expect(
      googleClientShapeProblem(
        "123456789012-abcdefghijklmnop.apps.googleusercontent.com",
        "GOCSPX-abcdefghijklmnopqrstuvwxyz1",
      ),
    ).toBeNull();
  });

  it("names what is wrong with a bad Google id or secret", () => {
    expect(googleClientShapeProblem("nope", "GOCSPX-abcdefghijklmnopqrstuvwxyz1")).toMatch(
      /client ID/,
    );
    expect(
      googleClientShapeProblem("123456789012-abcdefghijklmnop.apps.googleusercontent.com", "short"),
    ).toMatch(/client secret/);
  });

  it("wants a GUID for Microsoft", () => {
    expect(microsoftClientShapeProblem("11111111-2222-3333-4444-555555555555")).toBeNull();
    expect(microsoftClientShapeProblem("11111111")).toMatch(/Application \(client\) ID/);
  });
});
