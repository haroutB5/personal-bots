import { PersonalPushSubscriptionId, type PersonalPushDevice } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { phoneNotificationState } from "./thisPhoneModel";

const device = (deviceLabel: string): PersonalPushDevice =>
  ({
    subscriptionId: PersonalPushSubscriptionId.make("sub"),
    deviceLabel,
    endpointHost: "push.example.com",
    createdAt: DateTime.makeUnsafe("2026-11-01T10:00:00Z"),
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  }) as PersonalPushDevice;

describe("this phone notification state", () => {
  it("is unknown until push settings load", () => {
    expect(phoneNotificationState(null, "Find X9 Pro")).toBe("…");
  });

  it("is on when this label has a registered push device", () => {
    expect(phoneNotificationState([device("Find X9 Pro")], "Find X9 Pro")).toBe("On");
  });

  it("is off for another device's registration", () => {
    expect(phoneNotificationState([device("Mac")], "Find X9 Pro")).toBe("Off");
  });

  it("is off when nothing is registered", () => {
    expect(phoneNotificationState([], "Find X9 Pro")).toBe("Off");
  });
});
