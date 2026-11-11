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
    expect(app).toMatch(/<AppLockGate>\s*<AppShell/);
  });
});
