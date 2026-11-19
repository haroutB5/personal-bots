import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import {
  allowlistWritten,
  keptSettings,
  renderUserJs,
  resolveProfileDir,
  serverKeyOf,
} from "./profile.ts";

const FIXTURES = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "fixtures",
);

const tempHome = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-tb-profile-"));

describe("renderUserJs", () => {
  it("reproduces, byte for byte, the file measured on the laptop", () => {
    expect(renderUserJs()).toBe(
      NodeFS.readFileSync(NodePath.join(FIXTURES, "user.base.txt"), "utf8"),
    );
  });

  it("adds the allowlist and the offline copies after the base, sorted and without duplicates", () => {
    const base = renderUserJs();
    const full = renderUserJs({
      allowedAccounts: ["account3", "account1", "account1"],
      offlineServers: ["server3", "server1", "server1"],
    });
    expect(full.startsWith(base)).toBe(true);
    expect(full.slice(base.length)).toBe(
      [
        'user_pref("extensions.commonpost-mcp.allowedAccounts", "[\\"account1\\", \\"account3\\"]");',
        'user_pref("mail.server.server1.offline_download", true);',
        'user_pref("mail.server.server3.offline_download", true);',
        "",
      ].join("\n"),
    );
  });

  it("is the same bytes on every run and in any order of input", () => {
    const one = renderUserJs({ allowedAccounts: ["a", "b"], offlineServers: ["s2", "s1"] });
    const two = renderUserJs({ allowedAccounts: ["b", "a"], offlineServers: ["s1", "s2"] });
    expect(one).toBe(two);
  });

  it("locks every send and deletion tool out and keeps new tools disabled", () => {
    const text = renderUserJs();
    expect(text).toContain('\\"sendMail\\"');
    expect(text).toContain('"extensions.commonpost-mcp.blockSkipReview", true');
    expect(allowlistWritten(text)).toBe(false);
    expect(allowlistWritten(renderUserJs({ allowedAccounts: ["a"] }))).toBe(true);
  });
});

describe("resolveProfileDir", () => {
  it("reads the path of the named profile from profiles.ini", () => {
    const home = tempHome();
    try {
      NodeFS.mkdirSync(NodePath.join(home, ".thunderbird"));
      NodeFS.writeFileSync(
        NodePath.join(home, ".thunderbird", "profiles.ini"),
        "[Profile1]\nName=default\nIsRelative=1\nPath=abc.default\n\n[Profile0]\nName=hbots-mail\nIsRelative=1\nPath=vwnlk873.hbots-mail\n\n[General]\nVersion=2\n",
      );
      expect(resolveProfileDir(home)).toBe(
        NodePath.join(home, ".thunderbird", "vwnlk873.hbots-mail"),
      );
      expect(resolveProfileDir(home, "nope")).toBeNull();
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("is null when there is no profiles.ini", () => {
    const home = tempHome();
    try {
      expect(resolveProfileDir(home)).toBeNull();
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("serverKeyOf", () => {
  const prefs = [
    'user_pref("mail.account.account1.server", "server1");',
    'user_pref("mail.account.account12.server", "server7");',
    'user_pref("mail.server.server1.type", "imap");',
  ].join("\n");

  it("finds the incoming server of exactly that account", () => {
    expect(serverKeyOf(prefs, "account1")).toBe("server1");
    expect(serverKeyOf(prefs, "account12")).toBe("server7");
    expect(serverKeyOf(prefs, "account2")).toBeNull();
  });
});

describe("keptSettings", () => {
  it("reads back exactly what renderUserJs wrote", () => {
    const options = { allowedAccounts: ["account1", "account3"], offlineServers: ["server1"] };
    expect(keptSettings(renderUserJs(options))).toEqual(options);
  });

  it("finds nothing in the base file", () => {
    expect(keptSettings(renderUserJs())).toEqual({
      allowedAccounts: undefined,
      offlineServers: [],
    });
  });

  it("ignores an allowlist that is not a list of ids", () => {
    const text = 'user_pref("extensions.commonpost-mcp.allowedAccounts", "{\\"a\\":1}");\n';
    expect(keptSettings(text).allowedAccounts).toBeUndefined();
  });
});
