import * as NodeCrypto from "node:crypto";

export const THUNDERBIRD_ESR_VERSION = "153.7.0";
export const THUNDERBIRD_PROFILE_NAME = "hbots-mail";

export const COMMONPOST_ADDON_ID = "commonpost-mcp@commonpost.github.io";
export const COMMONPOST_ADDON_VERSION = "0.26.1";
export const COMMONPOST_XPI_SHA256 =
  "90f85d8e81c875d6ef5e20001c35b5101e784e93511e53f01699aee8b78ab1e9";
export const COMMONPOST_BRIDGE_SHA256 =
  "296d5a3b21cba49d7b263fa31e0391a8d4ea58909f8eee8b7a230b7393a23e24";
export const COMMONPOST_BRIDGE_PROFILE = "hbots";

/**
 * Every tool hbots may name. `sendMail`, `forwardMessage` and every delete
 * are absent on purpose: no code path can build such a call, and the add-on
 * has them switched off as well.
 */
export const COMMONPOST_TOOLS = [
  "listAccounts",
  "listFolders",
  "searchMessages",
  "getMessage",
  "getMessages",
  "getRecentMessages",
  "saveDraft",
  "replyToMessage",
] as const;
export type CommonpostTool = (typeof COMMONPOST_TOOLS)[number];

/** The add-on never lets these be disabled, so they stay on without being named in `CommonpostTool`. */
const ALWAYS_ENABLED = ["listAccounts", "listFolders", "getAccountAccess"] as const;

/** The full v0.26.1 list in the add-on's own order. A tool a later version adds starts disabled. */
export const COMMONPOST_KNOWN_TOOLS = [
  "listAccounts",
  "listFolders",
  "searchMessages",
  "getMessage",
  "getMessages",
  "sendMail",
  "saveDraft",
  "listCalendars",
  "createEvent",
  "listEvents",
  "updateEvent",
  "deleteEvent",
  "createTask",
  "listCategories",
  "listTasks",
  "updateTask",
  "deleteTask",
  "listAddressBooks",
  "searchContacts",
  "getContact",
  "createContact",
  "updateContact",
  "deleteContact",
  "replyToMessage",
  "forwardMessage",
  "getRecentMessages",
  "displayMessage",
  "deleteMessages",
  "updateMessage",
  "createFolder",
  "renameFolder",
  "deleteFolder",
  "emptyTrash",
  "emptyJunk",
  "moveFolder",
  "listFilters",
  "createFilter",
  "updateFilter",
  "deleteFilter",
  "reorderFilters",
  "applyFilters",
  "getAccountAccess",
] as const;

const ENABLED: ReadonlySet<string> = new Set<string>([...COMMONPOST_TOOLS, ...ALWAYS_ENABLED]);

export const COMMONPOST_ENABLED_TOOLS: ReadonlyArray<string> = COMMONPOST_KNOWN_TOOLS.filter(
  (tool) => ENABLED.has(tool),
);

export const COMMONPOST_DISABLED_TOOLS: ReadonlyArray<string> = COMMONPOST_KNOWN_TOOLS.filter(
  (tool) => !ENABLED.has(tool),
);

interface ListedTool {
  readonly name: string;
  readonly inputSchema: unknown;
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;

/**
 * A digest of the eight tools' names and argument schemas, so a reply that
 * differs from the one this build was reviewed against is detectable. Titles,
 * descriptions and annotations are left out: they can change without changing
 * what a call means.
 */
export const toolsFingerprint = (tools: ReadonlyArray<ListedTool>): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        COMMONPOST_TOOLS.map((name) => {
          const found = tools.find((tool) => tool.name === name);
          return canonical({ name, inputSchema: found?.inputSchema ?? null });
        }),
      ),
    )
    .digest("hex");

export const COMMONPOST_TOOLS_FINGERPRINT =
  "db95cfb2d28a795f03a2cee542874d0860a077587797b6ac10f6a17511528f16";

/** The schema id for a tools fingerprint: the reviewed one when the add-on is unchanged, another one when it is not. */
export const schemaOfFingerprint = (fingerprint: string): string =>
  `commonpost-mcp/${COMMONPOST_ADDON_VERSION}/tools@${fingerprint.slice(0, 16)}`;

export const COMMONPOST_REVIEWED_SCHEMA = schemaOfFingerprint(COMMONPOST_TOOLS_FINGERPRINT);
