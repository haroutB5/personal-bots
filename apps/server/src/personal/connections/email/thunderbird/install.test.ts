import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { autostartEntry, installThunderbird } from "./install.ts";
import { renderUserJs } from "./profile.ts";

const XPI = Buffer.from("fake xpi bytes");
const BRIDGE = Buffer.from("fake bridge bytes");
const digest = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const pinned = { xpiSha256: digest(XPI), bridgeSha256: digest(BRIDGE) };

const makeHome = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-install-"));
  NodeFS.mkdirSync(NodePath.join(home, ".thunderbird", "p.hbots-mail"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(home, ".thunderbird", "profiles.ini"),
    "[Profile0]\nName=hbots-mail\nIsRelative=1\nPath=p.hbots-mail\n",
  );
  NodeFS.mkdirSync(NodePath.join(home, "commonpost-mcp"));
  NodeFS.writeFileSync(NodePath.join(home, "commonpost-mcp", "mcp-bridge.cjs"), BRIDGE);
  const xpiSource = NodePath.join(home, "commonpost-mcp", "addon.xpi");
  NodeFS.writeFileSync(xpiSource, XPI);
  return { home, xpiSource, profile: NodePath.join(home, ".thunderbird", "p.hbots-mail") };
};

const snapshot = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[NodePath.relative(root, path)] = digest(NodeFS.readFileSync(path));
    }
  };
  walk(root);
  return out;
};

describe("installThunderbird", () => {
  it("a dry run reports every step and writes nothing", () => {
    const h = makeHome();
    const before = snapshot(h.home);
    const result = installThunderbird({
      home: h.home,
      xpiSource: h.xpiSource,
      dryRun: true,
      pinned,
    });
    expect(result).toMatchObject({
      _tag: "done",
      steps: [
        { what: "add-on", change: "created" },
        { what: "profile settings", change: "created" },
        { what: "autostart", change: "created" },
      ],
    });
    expect(snapshot(h.home)).toEqual(before);
  });

  it("writes the add-on, the base settings and the autostart entry, and a second run changes nothing", () => {
    const h = makeHome();
    const options = { home: h.home, xpiSource: h.xpiSource, dryRun: false, pinned };
    installThunderbird(options);
    const xpiPath = NodePath.join(
      h.profile,
      "extensions",
      "commonpost-mcp@commonpost.github.io.xpi",
    );
    expect(NodeFS.readFileSync(xpiPath).equals(XPI)).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(h.profile, "user.js"), "utf8")).toBe(renderUserJs());
    expect(
      NodeFS.readFileSync(
        NodePath.join(h.home, ".config", "autostart", "thunderbird.desktop"),
        "utf8",
      ),
    ).toBe(autostartEntry(h.home));
    const first = snapshot(h.home);
    const again = installThunderbird(options);
    expect(again._tag).toBe("done");
    if (again._tag === "done") {
      expect(again.steps.every((step) => step.change === "unchanged")).toBe(true);
    }
    expect(snapshot(h.home)).toEqual(first);
  });

  it("keeps the accounts the owner already confirmed on a reinstall", () => {
    const h = makeHome();
    const confirmed = renderUserJs({ allowedAccounts: ["account2"], offlineServers: ["server2"] });
    NodeFS.writeFileSync(NodePath.join(h.profile, "user.js"), confirmed);
    installThunderbird({ home: h.home, xpiSource: h.xpiSource, dryRun: false, pinned });
    expect(NodeFS.readFileSync(NodePath.join(h.profile, "user.js"), "utf8")).toBe(confirmed);
  });

  it("refuses an add-on file that is not the reviewed one and writes nothing", () => {
    const h = makeHome();
    NodeFS.writeFileSync(h.xpiSource, "tampered");
    const before = snapshot(h.home);
    const result = installThunderbird({
      home: h.home,
      xpiSource: h.xpiSource,
      dryRun: false,
      pinned,
    });
    expect(result._tag).toBe("refused");
    expect(snapshot(h.home)).toEqual(before);
  });

  it("refuses a bridge that is not the reviewed one, and a missing profile", () => {
    const h = makeHome();
    NodeFS.writeFileSync(NodePath.join(h.home, "commonpost-mcp", "mcp-bridge.cjs"), "other");
    expect(
      installThunderbird({ home: h.home, xpiSource: h.xpiSource, dryRun: false, pinned })._tag,
    ).toBe("refused");
    const bare = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-install-bare-"));
    const result = installThunderbird({ home: bare, xpiSource: "/nope", dryRun: false, pinned });
    expect(result).toMatchObject({
      _tag: "refused",
      reason: expect.stringContaining("profile is not in"),
    });
  });

  it("starts only the hbots-mail profile from the autostart entry", () => {
    expect(autostartEntry("/home/h")).toBe(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Thunderbird (hbots mail)",
        "Exec=/home/h/.local/bin/thunderbird -P hbots-mail",
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n"),
    );
  });
});
