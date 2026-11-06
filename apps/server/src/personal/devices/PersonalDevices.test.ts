import { AuthSessionId } from "@t3tools/contracts";
import type { AuthClientSession } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ServerAuthForbiddenOperationError } from "../../auth/EnvironmentAuth.ts";
import {
  listPersonalDevices,
  revokePersonalDevice,
  sortPersonalDevices,
  toPersonalDevice,
} from "./PersonalDevices.ts";

const id = (value: string) => AuthSessionId.make(value);
const at = (iso: string) => DateTime.makeUnsafe(iso);

const session = (
  sessionId: string,
  overrides: Partial<AuthClientSession> = {},
): AuthClientSession => ({
  sessionId: id(sessionId),
  subject: "owner",
  scopes: ["orchestration:read", "orchestration:operate"],
  method: "dpop-access-token",
  client: { label: "Find X9 Pro", deviceType: "mobile", os: "android" },
  issuedAt: at("2026-11-01T10:00:00Z"),
  expiresAt: at("2026-12-01T10:00:00Z"),
  lastConnectedAt: at("2026-11-06T09:00:00Z"),
  connected: true,
  current: false,
  ...overrides,
});

describe("personal device rows", () => {
  it("marks the calling session as this device and keeps the label", () => {
    const device = toPersonalDevice(session("phone"), id("phone"));
    expect(device.label).toBe("Find X9 Pro");
    expect(device.deviceType).toBe("mobile");
    expect(device.os).toBe("android");
    expect(device.relationship).toBe("this-device");
  });

  it("marks every other session as other", () => {
    expect(toPersonalDevice(session("phone"), id("browser")).relationship).toBe("other");
  });

  it("falls back to the device type when the session has no label", () => {
    const device = toPersonalDevice(
      session("phone", { client: { deviceType: "mobile" } }),
      id("browser"),
    );
    expect(device.label).toBe("Phone");
  });

  it("puts this device first and then the most recent connection", () => {
    const older = toPersonalDevice(
      session("older", { lastConnectedAt: at("2026-11-02T10:00:00Z") }),
      id("current"),
    );
    const current = toPersonalDevice(session("current"), id("current"));
    const newer = toPersonalDevice(
      session("newer", { lastConnectedAt: at("2026-11-06T08:00:00Z") }),
      id("current"),
    );
    expect(sortPersonalDevices([older, newer, current]).map((d) => d.sessionId)).toEqual([
      "current",
      "newer",
      "older",
    ]);
  });
});

describe("personal devices RPC", () => {
  it.effect("lists sessions through the auth service", () =>
    Effect.gen(function* () {
      let askedFor: string | null = null;
      const auth = {
        listClientSessions: (currentSessionId: string) => {
          askedFor = currentSessionId;
          return Effect.succeed([session("phone"), session("browser")]);
        },
        revokeClientSession: (_currentSessionId: string, _targetSessionId: string) =>
          Effect.succeed(true),
      };
      const result = yield* listPersonalDevices(auth, id("phone"));
      expect(askedFor).toBe("phone");
      expect(result.devices.map((device) => [device.sessionId, device.relationship])).toEqual([
        ["phone", "this-device"],
        ["browser", "other"],
      ]);
    }),
  );

  it.effect("revokes another session", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const auth = {
        listClientSessions: () => Effect.succeed([]),
        revokeClientSession: (_currentSessionId: string, targetSessionId: string) => {
          calls.push(targetSessionId);
          return Effect.succeed(true);
        },
      };
      const result = yield* revokePersonalDevice(auth as never, id("phone"), id("browser"));
      expect(result.revoked).toBe(true);
      expect(calls).toEqual(["browser"]);
    }),
  );

  it.effect("refuses to revoke this device and reports false", () =>
    Effect.gen(function* () {
      let called = false;
      const auth = {
        listClientSessions: () => Effect.succeed([]),
        revokeClientSession: () => {
          called = true;
          return Effect.succeed(true);
        },
      };
      const result = yield* revokePersonalDevice(auth as never, id("phone"), id("phone"));
      expect(result.revoked).toBe(false);
      expect(called).toBe(false);
    }),
  );

  it.effect("maps a forbidden revoke to false", () =>
    Effect.gen(function* () {
      const auth = {
        listClientSessions: () => Effect.succeed([]),
        revokeClientSession: () => Effect.fail(new ServerAuthForbiddenOperationError({})),
      };
      const result = yield* revokePersonalDevice(auth as never, id("phone"), id("browser"));
      expect(result.revoked).toBe(false);
    }),
  );
});
