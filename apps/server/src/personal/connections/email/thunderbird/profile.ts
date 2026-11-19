import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  COMMONPOST_DISABLED_TOOLS,
  COMMONPOST_KNOWN_TOOLS,
  THUNDERBIRD_PROFILE_NAME,
} from "./pins.ts";

/**
 * The folder of the named profile, read from `profiles.ini` so no profile
 * path is written down anywhere. Null when the profile does not exist.
 */
export const resolveProfileDir = (
  home: string,
  name: string = THUNDERBIRD_PROFILE_NAME,
): string | null => {
  const root = NodePath.join(home, ".thunderbird");
  let ini: string;
  try {
    ini = NodeFS.readFileSync(NodePath.join(root, "profiles.ini"), "utf8");
  } catch {
    return null;
  }
  for (const section of ini.split(/\r?\n(?=\[)/)) {
    const fields = new Map(
      section.split(/\r?\n/).flatMap((line) => {
        const at = line.indexOf("=");
        return at < 0 ? [] : [[line.slice(0, at).trim(), line.slice(at + 1).trim()] as const];
      }),
    );
    if (fields.get("Name") !== name) continue;
    const path = fields.get("Path");
    if (path === undefined || path === "") return null;
    return fields.get("IsRelative") === "0" ? path : NodePath.join(root, path);
  }
  return null;
};

const HEADER =
  "// hbots-managed. Reapplied at every Thunderbird start. See dev-team/qa/hbots-email/WALKTHROUGH.md";

const pref = (name: string, value: boolean | number | string) =>
  `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`;

const jsonList = (items: ReadonlyArray<string>) =>
  `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;

export interface UserJsOptions {
  /** Account ids bots may use. Absent until the owner confirms them. */
  readonly allowedAccounts?: ReadonlyArray<string>;
  /** Incoming server keys that keep a full offline copy, so body search works on IMAP. */
  readonly offlineServers?: ReadonlyArray<string>;
}

/**
 * The whole `user.js`. Written from nothing each time, so running it twice
 * gives the same bytes and a setting changed in the add-on's own options page
 * is put back at the next start.
 */
export const renderUserJs = (options: UserJsOptions = {}): string => {
  const lines = [
    HEADER,
    pref("extensions.autoDisableScopes", 0),
    pref("extensions.update.enabled", false),
    pref("extensions.update.autoUpdateDefault", false),
    pref("extensions.commonpost-mcp.blockSkipReview", true),
    pref("extensions.commonpost-mcp.blockCalendarSkipReview", true),
    pref("extensions.commonpost-mcp.blockFilterForwardReply", true),
    pref("extensions.commonpost-mcp.listenAll", false),
    pref("extensions.commonpost-mcp.allowEncryptedContent", false),
    pref("extensions.commonpost-mcp.disabledTools", jsonList(COMMONPOST_DISABLED_TOOLS)),
    pref("extensions.commonpost-mcp.knownTools", jsonList(COMMONPOST_KNOWN_TOOLS)),
    pref("mailnews.database.global.indexer.enabled", true),
    ...(options.allowedAccounts === undefined
      ? []
      : [
          pref(
            "extensions.commonpost-mcp.allowedAccounts",
            jsonList([...new Set(options.allowedAccounts)].toSorted()),
          ),
        ]),
    ...[...new Set(options.offlineServers ?? [])]
      .toSorted()
      .map((key) => pref(`mail.server.${key}.offline_download`, true)),
  ];
  return `${lines.join("\n")}\n`;
};

const ALLOWED_PREF = /^user_pref\("extensions\.commonpost-mcp\.allowedAccounts", /m;

export const allowlistWritten = (userJs: string): boolean => ALLOWED_PREF.test(userJs);

/** The incoming server key Thunderbird gave an account, from the profile's `prefs.js`. */
export const serverKeyOf = (prefsJs: string, accountId: string): string | null => {
  const name = `mail.account.${accountId}.server`;
  for (const line of prefsJs.split(/\r?\n/)) {
    const match = /^user_pref\("([^"]+)", "([^"]*)"\);$/.exec(line.trim());
    if (match !== null && match[1] === name && (match[2] ?? "") !== "") return match[2] ?? null;
  }
  return null;
};

const ALLOWED_LINE = /^user_pref\("extensions\.commonpost-mcp\.allowedAccounts", (".*")\);$/m;
const OFFLINE_LINE = /^user_pref\("mail\.server\.([A-Za-z0-9_]+)\.offline_download", true\);$/gm;

/**
 * The owner's choices already written in a `user.js`, so a reinstall puts the
 * same ones back instead of asking again.
 */
export const keptSettings = (userJs: string): UserJsOptions => {
  const allowed = ALLOWED_LINE.exec(userJs)?.[1];
  let allowedAccounts: ReadonlyArray<string> | undefined;
  if (allowed !== undefined) {
    try {
      const inner: unknown = JSON.parse(JSON.parse(allowed) as string);
      if (Array.isArray(inner) && inner.every((id) => typeof id === "string")) {
        allowedAccounts = inner as ReadonlyArray<string>;
      }
    } catch {
      allowedAccounts = undefined;
    }
  }
  const offlineServers = [...userJs.matchAll(OFFLINE_LINE)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  return { allowedAccounts, offlineServers };
};
