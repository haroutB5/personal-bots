import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  COMMONPOST_ADDON_ID,
  COMMONPOST_ADDON_VERSION,
  COMMONPOST_BRIDGE_SHA256,
  COMMONPOST_XPI_SHA256,
  THUNDERBIRD_PROFILE_NAME,
} from "./pins.ts";
import { keptSettings, renderUserJs, resolveProfileDir } from "./profile.ts";

export interface InstallOptions {
  readonly home: string;
  readonly xpiSource: string;
  readonly dryRun: boolean;
  /** The reviewed hashes. Tests pass their own, the command never does. */
  readonly pinned?: { readonly xpiSha256: string; readonly bridgeSha256: string };
}

export type InstallChange = "created" | "updated" | "unchanged";

export interface InstallStep {
  readonly what: string;
  readonly path: string;
  readonly change: InstallChange;
}

export type InstallResult =
  | { readonly _tag: "done"; readonly steps: ReadonlyArray<InstallStep> }
  | { readonly _tag: "refused"; readonly reason: string };

const sha256 = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const readBytes = (path: string): Buffer | null => {
  try {
    return NodeFS.readFileSync(path);
  } catch {
    return null;
  }
};

export const autostartEntry = (home: string): string =>
  [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Thunderbird (hbots mail)",
    `Exec=${NodePath.join(home, ".local", "bin", "thunderbird")} -P ${THUNDERBIRD_PROFILE_NAME}`,
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");

export const defaultXpiSource = (home: string): string =>
  NodePath.join(home, "commonpost-mcp", `commonpost-mcp-v${COMMONPOST_ADDON_VERSION}.xpi`);

const place = (path: string, next: Buffer, dryRun: boolean, what: string): InstallStep => {
  const current = readBytes(path);
  const change: InstallChange =
    current === null ? "created" : current.equals(next) ? "unchanged" : "updated";
  if (change !== "unchanged" && !dryRun) {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    const temp = `${path}.hbots-tmp`;
    NodeFS.writeFileSync(temp, next);
    NodeFS.renameSync(temp, path);
  }
  return { what, path, change };
};

export const installThunderbird = (options: InstallOptions): InstallResult => {
  const profileDir = resolveProfileDir(options.home);
  if (profileDir === null) {
    return {
      _tag: "refused",
      reason: `The ${THUNDERBIRD_PROFILE_NAME} profile is not in ${NodePath.join(options.home, ".thunderbird", "profiles.ini")}. Create it first.`,
    };
  }
  const pinned = options.pinned ?? {
    xpiSha256: COMMONPOST_XPI_SHA256,
    bridgeSha256: COMMONPOST_BRIDGE_SHA256,
  };
  const xpi = readBytes(options.xpiSource);
  if (xpi === null) {
    return { _tag: "refused", reason: `The add-on file ${options.xpiSource} is not there.` };
  }
  if (sha256(xpi) !== pinned.xpiSha256) {
    return {
      _tag: "refused",
      reason: `${options.xpiSource} is not the reviewed Commonpost ${COMMONPOST_ADDON_VERSION} add-on.`,
    };
  }
  const bridgePath = NodePath.join(options.home, "commonpost-mcp", "mcp-bridge.cjs");
  const bridge = readBytes(bridgePath);
  if (bridge === null || sha256(bridge) !== pinned.bridgeSha256) {
    return { _tag: "refused", reason: `${bridgePath} is missing or is not the reviewed bridge.` };
  }

  const userJsPath = NodePath.join(profileDir, "user.js");
  const existing = readBytes(userJsPath)?.toString("utf8");
  const userJs = renderUserJs(existing === undefined ? {} : keptSettings(existing));

  return {
    _tag: "done",
    steps: [
      place(
        NodePath.join(profileDir, "extensions", `${COMMONPOST_ADDON_ID}.xpi`),
        xpi,
        options.dryRun,
        "add-on",
      ),
      place(userJsPath, Buffer.from(userJs), options.dryRun, "profile settings"),
      place(
        NodePath.join(options.home, ".config", "autostart", "thunderbird.desktop"),
        Buffer.from(autostartEntry(options.home)),
        options.dryRun,
        "autostart",
      ),
    ],
  };
};
