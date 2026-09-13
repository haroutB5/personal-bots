import { describe, expect, it } from "vite-plus/test";

import { offlineBannerText } from "./offlineBanner";
import {
  applicationServerKeyFrom,
  isNavigablePath,
  shouldRegisterServiceWorker,
} from "./serviceWorker";

const NOW = Date.parse("2026-09-14T12:00:00Z");

describe("offlineBannerText", () => {
  it("is silent while connected and on the first cold connect", () => {
    expect(offlineBannerText("connected", NOW - 5_000, NOW)).toBeNull();
    expect(offlineBannerText("connecting", null, NOW)).toBeNull();
  });

  it("states the last contact once the laptop is unreachable", () => {
    expect(offlineBannerText("reconnecting", NOW - 5 * 60_000, NOW)).toBe(
      "Laptop offline · last contact 5m ago",
    );
    expect(offlineBannerText("offline", NOW - 10_000, NOW)).toBe(
      "Laptop offline · last contact just now",
    );
    expect(offlineBannerText("error", Date.parse("2026-09-13T20:00:00Z"), NOW)).toBe(
      "Laptop offline · last contact Yesterday",
    );
    expect(offlineBannerText("offline", null, NOW)).toBe("Laptop offline");
  });
});

describe("service worker gating", () => {
  it("registers only in production, on a secure origin, outside Electron", () => {
    const base = { production: true, secureContext: true, electron: false, supported: true };
    expect(shouldRegisterServiceWorker(base)).toBe(true);
    expect(shouldRegisterServiceWorker({ ...base, production: false })).toBe(false);
    expect(shouldRegisterServiceWorker({ ...base, secureContext: false })).toBe(false);
    expect(shouldRegisterServiceWorker({ ...base, electron: true })).toBe(false);
    expect(shouldRegisterServiceWorker({ ...base, supported: false })).toBe(false);
  });

  it("accepts only same-origin paths from the worker", () => {
    expect(isNavigablePath("/tasks/abc")).toBe(true);
    expect(isNavigablePath("//evil.example/x")).toBe(false);
    expect(isNavigablePath("https://evil.example/x")).toBe(false);
    expect(isNavigablePath(42)).toBe(false);
  });

  it("decodes a base64url VAPID key into its 65 raw bytes", () => {
    const key =
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const bytes = applicationServerKeyFrom(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });
});
