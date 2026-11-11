import { describe, expect, it } from "vite-plus/test";

import { parseDeepLink } from "../nav/routes";
import { isCovered, lockStateAtLaunch, returned, leftApp, type Lock } from "../security/appLock";

const lockOn: Lock = { kind: "on", timeout: "immediate" };
const lockOff: Lock = { kind: "off" };

describe("the hbots://stop link", () => {
  it("opens the Stop list on top of Bots home and nothing else", () => {
    expect(parseDeepLink("hbots://stop")).toEqual({
      stack: [{ kind: "tab", tab: "bots" }, { kind: "stop" }],
    });
  });

  it("ignores query text, so a notification cannot steer it", () => {
    expect(parseDeepLink("hbots://stop?thread=t1&then=settings")).toEqual(
      parseDeepLink("hbots://stop"),
    );
  });

  it("is a different link from the other routes", () => {
    expect(parseDeepLink("hbots://stopp")).toBeNull();
    expect(parseDeepLink("https://stop")).toBeNull();
  });
});

describe("the Stop list behind the app lock", () => {
  // The route mounts under AppLockGate like every other route; the gate covers it while locked.
  it("is covered after a cold start from the notification when the lock is on", () => {
    expect(parseDeepLink("hbots://stop")).not.toBeNull();
    expect(isCovered(lockStateAtLaunch(lockOn), lockOn)).toBe(true);
  });

  it("is covered when the app returns after the lock timeout", () => {
    const away = returned(leftApp({ locked: false, leftAt: null }, 0), lockOn, 1);
    expect(isCovered(away, lockOn)).toBe(true);
  });

  it("is open at once when the lock is off", () => {
    expect(isCovered(lockStateAtLaunch(lockOff), lockOff)).toBe(false);
  });
});
