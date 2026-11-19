// Run: node --test scripts/personal/linux/hbots-mail/install-thunderbird.test.ts
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
const { test } = NodeTest;

import { renderUserJs } from "../../../../apps/server/src/personal/connections/email/thunderbird/profile.ts";
import { autostartEntry, installThunderbird } from "./install-thunderbird.ts";

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

test("a dry run reports every step and writes nothing", () => {
  const h = makeHome();
  const before = snapshot(h.home);
  const result = installThunderbird({ home: h.home, xpiSource: h.xpiSource, dryRun: true, pinned });
  NodeAssert.equal(result._tag, "done");
  if (result._tag === "done") {
    NodeAssert.deepEqual(
      result.steps.map((step) => [step.what, step.change]),
      [
        ["add-on", "created"],
        ["profile settings", "created"],
        ["autostart", "created"],
      ],
    );
  }
  NodeAssert.deepEqual(snapshot(h.home), before);
});

test("an install writes the add-on, the base settings and the autostart entry, and a second run changes nothing", () => {
  const h = makeHome();
  const options = { home: h.home, xpiSource: h.xpiSource, dryRun: false, pinned };
  installThunderbird(options);
  NodeAssert.deepEqual(
    NodeFS.readFileSync(
      NodePath.join(h.profile, "extensions", "commonpost-mcp@commonpost.github.io.xpi"),
    ),
    XPI,
  );
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(h.profile, "user.js"), "utf8"),
    renderUserJs(),
  );
  NodeAssert.equal(
    NodeFS.readFileSync(
      NodePath.join(h.home, ".config", "autostart", "thunderbird.desktop"),
      "utf8",
    ),
    autostartEntry(h.home),
  );
  const first = snapshot(h.home);
  const again = installThunderbird(options);
  NodeAssert.equal(again._tag, "done");
  if (again._tag === "done") {
    NodeAssert.ok(again.steps.every((step) => step.change === "unchanged"));
  }
  NodeAssert.deepEqual(snapshot(h.home), first);
});

test("a reinstall keeps the accounts the owner already confirmed", () => {
  const h = makeHome();
  const confirmed = renderUserJs({ allowedAccounts: ["account2"], offlineServers: ["server2"] });
  NodeFS.writeFileSync(NodePath.join(h.profile, "user.js"), confirmed);
  installThunderbird({ home: h.home, xpiSource: h.xpiSource, dryRun: false, pinned });
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(h.profile, "user.js"), "utf8"), confirmed);
});

test("an add-on file that is not the reviewed one is refused and nothing is written", () => {
  const h = makeHome();
  NodeFS.writeFileSync(h.xpiSource, "tampered");
  const before = snapshot(h.home);
  const result = installThunderbird({
    home: h.home,
    xpiSource: h.xpiSource,
    dryRun: false,
    pinned,
  });
  NodeAssert.equal(result._tag, "refused");
  NodeAssert.deepEqual(snapshot(h.home), before);
});

test("a bridge that is not the reviewed one, or a missing profile, is refused", () => {
  const h = makeHome();
  NodeFS.writeFileSync(NodePath.join(h.home, "commonpost-mcp", "mcp-bridge.cjs"), "other");
  NodeAssert.equal(
    installThunderbird({ home: h.home, xpiSource: h.xpiSource, dryRun: false, pinned })._tag,
    "refused",
  );
  const bare = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-install-bare-"));
  const result = installThunderbird({ home: bare, xpiSource: "/nope", dryRun: false, pinned });
  NodeAssert.equal(result._tag, "refused");
  if (result._tag === "refused") NodeAssert.match(result.reason, /profile is not in/);
});

test("the autostart entry starts only the hbots-mail profile", () => {
  NodeAssert.equal(
    autostartEntry("/home/h"),
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
