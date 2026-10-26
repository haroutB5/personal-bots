import { describe, expect, it } from "vite-plus/test";

import { hostPathCandidates, isProtectedHostPath, type HostPathContext } from "./HostFilePaths.ts";

const context: HostPathContext = {
  workspaceRoot: "/home/harout/.personal-bots/dev/personal-workspace",
  homeDir: "/home/harout",
  pathMap: "C:/Users/Ht=/home/harout;C:/Claude/AI=/home/harout/Claude/AI",
};

describe("hostPathCandidates", () => {
  it("tries the workspace first, then the home folder, for a relative path", () => {
    expect(hostPathCandidates(".personal-bots/qa/x/RESULT.md", context)).toEqual([
      "/home/harout/.personal-bots/dev/personal-workspace/.personal-bots/qa/x/RESULT.md",
      "/home/harout/.personal-bots/qa/x/RESULT.md",
    ]);
  });

  it("tries only the home folder when the chat has no workspace", () => {
    expect(hostPathCandidates("notes/a.md", { ...context, workspaceRoot: undefined })).toEqual([
      "/home/harout/notes/a.md",
    ]);
  });

  it("uses an absolute path as it is", () => {
    expect(hostPathCandidates("/tmp/report.pdf", context)).toEqual(["/tmp/report.pdf"]);
  });

  it("expands ~/ under the home folder", () => {
    expect(hostPathCandidates("~/Claude/AI/notes.md", context)).toEqual([
      "/home/harout/Claude/AI/notes.md",
    ]);
  });

  it("maps a Windows path through the path map, longest root first", () => {
    expect(hostPathCandidates("C:/Claude/AI/dev-team/HANDBOOK.md", context)).toEqual([
      "/home/harout/Claude/AI/dev-team/HANDBOOK.md",
    ]);
    expect(hostPathCandidates("C:\\Users\\Ht\\Desktop\\a.md", context)).toEqual([
      "/home/harout/Desktop/a.md",
    ]);
  });

  it("has no candidate for a Windows path outside the map", () => {
    expect(hostPathCandidates("D:/other/file.md", context)).toEqual([]);
    expect(hostPathCandidates("C:/Claude/AI/x.md", { ...context, pathMap: undefined })).toEqual([]);
  });

  it("keeps ../ from climbing out of the workspace or the home folder", () => {
    expect(hostPathCandidates("../../../../etc/passwd", context)).toEqual([]);
    expect(hostPathCandidates("~/../other/file.md", context)).toEqual([]);
    expect(hostPathCandidates("a/../../..//secret.md", context)).toEqual([]);
  });

  it("rejects empty paths and NUL bytes", () => {
    expect(hostPathCandidates("  ", context)).toEqual([]);
    expect(hostPathCandidates("a\0b.md", context)).toEqual([]);
  });
});

describe("isProtectedHostPath", () => {
  it.each([
    "/home/harout/.env",
    "/home/harout/app/.env.local",
    "/home/harout/.personal-bots/dev/userdata/state.sqlite",
    "/home/harout/.personal-bots/dev/userdata/state.sqlite-wal",
    "/home/harout/.personal-bots/dev/userdata/secrets/key",
    "/home/harout/.personal-bots/dev/userdata/settings.json",
    "/home/harout/.personal-bots/dev/personal/browser-profiles/default/Default/Cookies",
    "/home/harout/.personal-bots/dev/personal/browser-profiles/default/Default/Login Data",
    "/home/harout/.personal-bots/dev/personal/browser-profiles/default/Local State",
    "/home/harout/.personal-bots/dev/personal/browser-profiles/default/Default/Web Data",
    "/home/harout/.config/BraveSoftware/Brave-Browser/Default/Cookies",
    "/home/harout/.config/google-chrome/Default/Login Data",
    "/home/harout/.config/chromium/Default/Local State",
    "/home/harout/.config/mozilla/firefox/x/logins.json",
    "/home/harout/.pgpass",
    "/home/harout/.my.cnf",
    "/etc/sudoers.d/90-cloud-init-users",
    "/home/harout/.ssh/id_ed25519",
    "/home/harout/.ssh/config",
    "/home/harout/.aws/credentials",
    "/home/harout/.config/gh/hosts.yml",
    "/home/harout/.docker/config.json",
    "/home/harout/work/auth.json",
    "/home/harout/work/server.pem",
    "/home/harout/work/private.key",
    "/home/harout/work/github-token.txt",
    "/home/harout/.npmrc",
    "/home/harout/.git-credentials",
    "/etc/shadow",
    "/proc/self/environ",
    "/run/secrets/db",
    "/home/harout/x/y/.env",
  ])("refuses %s", (target) => {
    expect(isProtectedHostPath(target)).toBe(true);
  });

  it.each([
    "/home/harout/.personal-bots/qa/backend-16697-lock/RESULT.md",
    "/home/harout/.personal-bots/dev/userdata/attachments/a-b.png",
    "/home/harout/work/.env.example",
    "/home/harout/work/.env.template",
    "/home/harout/Claude/AI/dev-team/HANDBOOK.md",
    "/tmp/report.pdf",
    "/home/harout/work/package.json",
    "/home/harout/work/keyboard.md",
  ])("allows %s", (target) => {
    expect(isProtectedHostPath(target)).toBe(false);
  });

  it("looks through ../ and backslashes", () => {
    expect(isProtectedHostPath("/home/harout/work/../.ssh/id_rsa")).toBe(true);
    expect(isProtectedHostPath("C:\\Users\\Ht\\.ssh\\id_rsa")).toBe(true);
  });

  it("lets a denied folder win over the .env.example template exemption", () => {
    expect(isProtectedHostPath("/home/harout/.ssh/.env.example")).toBe(true);
    expect(
      isProtectedHostPath("/home/harout/.config/BraveSoftware/Brave-Browser/.env.example"),
    ).toBe(true);
    expect(isProtectedHostPath("/home/harout/.personal-bots/dev/userdata/.env.example")).toBe(true);
  });
});
