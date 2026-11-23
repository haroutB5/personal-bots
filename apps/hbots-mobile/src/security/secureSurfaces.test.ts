import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

function source(path: string): string {
  return NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("FLAG_SECURE surfaces", () => {
  it("the Files tab holds the secure-screen flag while it is shown", () => {
    const files = source("../files/FilesScreen.tsx");
    expect(files).toContain('from "../platform/secureScreen"');
    expect(files).toMatch(/export function FilesScreen\([^)]*\)\s*\{\s*useSecureScreen\(true\);/);
  });

  it("the lock covers the signed-in app", () => {
    const app = source("../App.tsx");
    expect(app).toMatch(/<AppLockGate\b[\s\S]*?>\s*<AppShell/);
  });

  it("the Computer tab locks only for a password field or a sensitive-site pause", () => {
    const screen = source("../computer/ComputerScreen.tsx");
    expect(screen, "ComputerScreen must not lock FLAG_SECURE unconditionally").not.toContain(
      "useSecureScreen(true)",
    );
    expect(screen).toMatch(
      /useSecureScreen\(\s*computerScreenSecure\(\{[\s\S]*?passwordFieldOpen: passwordFields > 0,[\s\S]*?sensitivePauseShown: pause !== null,/,
    );
    const live = source("../computer/ComputerLiveView.tsx");
    expect(live).toContain("liveViewPasswordOpen({ keyboardOpen, field })");
  });

  it("settings screens do not unconditionally block screenshots with useSecureScreen(true)", () => {
    for (const file of [
      "../settings/SettingsScreen.tsx",
      "../settings/VoiceSettingsSection.tsx",
      "../settings/ProviderScreen.tsx",
      "../settings/MemoryScreen.tsx",
      "../settings/ApiKeysScreen.tsx",
      "../settings/PasswordsScreen.tsx",
      "../settings/ConnectionsScreen.tsx",
    ]) {
      const content = source(file);
      expect(content, `${file} must not lock FLAG_SECURE unconditionally`).not.toContain(
        "useSecureScreen(true)",
      );
    }
  });
});
