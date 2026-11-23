import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const store = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    store.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    store.delete(key);
  },
}));

const {
  RESCUE_REBOOT_STORAGE_KEY,
  clearRescueReboot,
  loadRescueReboot,
  parseRescueRebootConfig,
  saveRescueReboot,
} = await import("./rescueRebootStore");
const { clearSession } = await import("../session");

beforeEach(() => {
  store.clear();
});

describe("rescueRebootStore", () => {
  it("saves, loads, and clears a valid https rescue config", async () => {
    const saved = await saveRescueReboot({
      url: "https://rescue.example.com/reboot",
      token: "  tok-abc-123  ",
    });
    expect(saved).toBe(true);
    expect(store.has(RESCUE_REBOOT_STORAGE_KEY)).toBe(true);
    expect(await loadRescueReboot()).toEqual({
      url: "https://rescue.example.com/reboot",
      token: "tok-abc-123",
    });

    await clearRescueReboot();
    expect(await loadRescueReboot()).toBeNull();
  });

  it("rejects non-https URLs, malformed URLs, and empty tokens", async () => {
    expect(await saveRescueReboot({ url: "http://rescue.example.com/reboot", token: "tok" })).toBe(
      false,
    );
    expect(await saveRescueReboot({ url: "not-a-url", token: "tok" })).toBe(false);
    expect(await saveRescueReboot({ url: "https://rescue.example.com/reboot", token: "   " })).toBe(
      false,
    );
    expect(store.size).toBe(0);

    expect(parseRescueRebootConfig(null)).toBeNull();
    expect(parseRescueRebootConfig({ url: "javascript:alert(1)", token: "tok" })).toBeNull();
  });

  it("returns null on corrupt stored JSON", async () => {
    store.set(RESCUE_REBOOT_STORAGE_KEY, "{broken json");
    expect(await loadRescueReboot()).toBeNull();
  });

  it("is wiped when clearSession() runs on sign-out", async () => {
    await saveRescueReboot({
      url: "https://rescue.example.com/reboot",
      token: "tok-signout",
    });
    expect(await loadRescueReboot()).not.toBeNull();
    await clearSession();
    expect(await loadRescueReboot()).toBeNull();
  });
});
