import { describe, expect, it } from "vite-plus/test";

import {
  BROWSER_EXECUTABLE_ENV,
  braveExecutableCandidates,
  discoverBraveExecutable,
  resolveBrowserExecutable,
} from "./browserExecutable.ts";

const LOCAL = "C:\\Users\\me\\AppData\\Local";
const PROGRAM_FILES = "C:\\Program Files";
const PROGRAM_FILES_X86 = "C:\\Program Files (x86)";
const LOCAL_BRAVE = `${LOCAL}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`;
const MACHINE_BRAVE = `${PROGRAM_FILES}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`;
const X86_BRAVE = `${PROGRAM_FILES_X86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`;

const windowsEnv = {
  LOCALAPPDATA: LOCAL,
  ProgramFiles: PROGRAM_FILES,
  "ProgramFiles(x86)": PROGRAM_FILES_X86,
};

describe("browser executable selection", () => {
  it("checks the ordinary Windows Brave install locations, user install first", () => {
    expect(braveExecutableCandidates(windowsEnv, "win32")).toEqual([
      LOCAL_BRAVE,
      MACHINE_BRAVE,
      X86_BRAVE,
    ]);
  });

  it("uses the installed Brave when nothing is configured", () => {
    expect(
      resolveBrowserExecutable({
        env: windowsEnv,
        platform: "win32",
        exists: (path) => path === MACHINE_BRAVE,
      }),
    ).toBe(MACHINE_BRAVE);
  });

  it("lets an explicit Brave path win over discovery", () => {
    expect(
      resolveBrowserExecutable({
        configured: "D:\\Tools\\Brave\\brave.exe",
        env: windowsEnv,
        platform: "win32",
        exists: (path) => path === "D:\\Tools\\Brave\\brave.exe" || path === LOCAL_BRAVE,
      }),
    ).toBe("D:\\Tools\\Brave\\brave.exe");
  });

  it("reads the explicit path from the environment", () => {
    expect(
      resolveBrowserExecutable({
        env: { ...windowsEnv, [BROWSER_EXECUTABLE_ENV]: LOCAL_BRAVE },
        platform: "win32",
        exists: (path) => path === LOCAL_BRAVE,
      }),
    ).toBe(LOCAL_BRAVE);
  });

  it("refuses an explicitly configured Chrome instead of launching it", () => {
    const chrome = `${PROGRAM_FILES}\\Google\\Chrome\\Application\\chrome.exe`;
    expect(() =>
      resolveBrowserExecutable({
        configured: chrome,
        env: windowsEnv,
        platform: "win32",
        exists: () => true,
      }),
    ).toThrow(/not Brave.*Chrome is not used/);
  });

  it("fails clearly, with every checked path, when Brave is absent", () => {
    let error: unknown;
    try {
      resolveBrowserExecutable({ env: windowsEnv, platform: "win32", exists: () => false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("BrowserExecutableUnavailable");
    expect((error as Error).message).toContain("Brave browser not found");
    expect((error as Error).message).toContain("Chrome is not used as a fallback");
    expect((error as { candidates: ReadonlyArray<string> }).candidates).toEqual([
      LOCAL_BRAVE,
      MACHINE_BRAVE,
      X86_BRAVE,
    ]);
  });

  it("fails clearly when a configured path does not exist", () => {
    expect(() =>
      resolveBrowserExecutable({
        configured: "D:\\Missing\\brave.exe",
        env: windowsEnv,
        platform: "win32",
        exists: () => false,
      }),
    ).toThrow(/Configured Brave executable not found/);
  });

  it("uses the standard Linux locations off Windows", () => {
    expect(discoverBraveExecutable({}, "linux", (path) => path === "/usr/bin/brave")).toBe(
      "/usr/bin/brave",
    );
  });
});
