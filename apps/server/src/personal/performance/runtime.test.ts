import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  childSessionIds,
  releaseFolders,
  resumeIdFromCommandLine,
  sessionIdFromCommandLine,
  sizeOfDirectory,
} from "./runtime.ts";

describe("session ids from a provider CLI command line", () => {
  it("reads --session-id in both spellings", () => {
    expect(
      sessionIdFromCommandLine(
        "C:\\Users\\Ht\\.local\\bin\\claude.EXE --output-format stream-json --session-id=b1ef3808-58f4-40ec-81ed-a9a6af7a8f65 --verbose",
      ),
    ).toBe("b1ef3808-58f4-40ec-81ed-a9a6af7a8f65");
    expect(sessionIdFromCommandLine("claude --session-id ABCDEF01")).toBe("abcdef01");
  });

  it("reads --resume, and nothing else", () => {
    expect(resumeIdFromCommandLine("claude --resume=0f9e1188-23c4")).toBe("0f9e1188-23c4");
    expect(sessionIdFromCommandLine("chrome.exe --user-data-dir=hbots")).toBeNull();
    expect(sessionIdFromCommandLine("")).toBeNull();
  });

  it("pairs each child pid with its session id", () => {
    const pairs = childSessionIds([
      {
        pid: 101,
        name: "claude.exe",
        cpu100ns: 0,
        wsBytes: 0,
        cmd: "claude --session-id=aaaa1111",
      },
      { pid: 102, name: "cloudflared.exe", cpu100ns: 0, wsBytes: 0, cmd: "cloudflared tunnel run" },
      { pid: 103, name: "claude.exe", cpu100ns: 0, wsBytes: 0, cmd: "claude --resume=bbbb2222" },
    ]);
    expect(pairs).toEqual([
      { pid: 101, sessionId: "aaaa1111" },
      { pid: 103, sessionId: "bbbb2222" },
    ]);
  });
});

describe("releaseFolders", () => {
  it("keeps backups and releases beside the live data roots", () => {
    const folders = releaseFolders("C:\\Users\\Ht\\.personal-bots\\dev");
    expect(folders.backups).toBe("C:\\Users\\Ht\\.personal-bots\\backups");
    expect(folders.releases).toBe("C:\\Users\\Ht\\.personal-bots\\releases");
  });

  it("keeps them inside any other root, where a throwaway server would", () => {
    const folders = releaseFolders("C:\\Users\\Ht\\AppData\\Local\\Temp\\hbots-tw-x");
    expect(folders.backups).toContain("hbots-tw-x");
  });
});

describe("sizeOfDirectory", () => {
  it("sums nested files and ignores links", async () => {
    const dir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "perf-size-"));
    try {
      await NodeFSPromises.mkdir(NodePath.join(dir, "nested"));
      await NodeFSPromises.writeFile(NodePath.join(dir, "a.bin"), Buffer.alloc(1000));
      await NodeFSPromises.writeFile(NodePath.join(dir, "nested", "b.bin"), Buffer.alloc(2000));
      const bytes = await sizeOfDirectory(dir);
      expect(bytes).toBe(3000);
    } finally {
      await NodeFSPromises.rm(dir, { recursive: true, force: true });
    }
  });

  it("answers null for a folder that is not there", async () => {
    expect(await sizeOfDirectory("C:\\nope-does-not-exist-1672")).toBeNull();
  });
});
