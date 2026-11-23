import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import {
  COMMONPOST_DISABLED_TOOLS,
  COMMONPOST_ENABLED_TOOLS,
  COMMONPOST_KNOWN_TOOLS,
  COMMONPOST_REVIEWED_SCHEMA,
  COMMONPOST_TOOLS,
  COMMONPOST_TOOLS_FINGERPRINT,
  toolsFingerprint,
} from "./pins.ts";

const FIXTURE = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "fixtures",
  "tools-list-0.26.1.json",
);

const recorded = (): {
  readonly result: { readonly tools: ReadonlyArray<{ name: string; inputSchema: unknown }> };
} => JSON.parse(NodeFS.readFileSync(FIXTURE, "utf8"));

describe("the pinned Thunderbird tool set", () => {
  it("lists the 42 tools of add-on 0.26.1 with no duplicate", () => {
    expect(COMMONPOST_KNOWN_TOOLS).toHaveLength(42);
    expect(new Set(COMMONPOST_KNOWN_TOOLS).size).toBe(42);
  });

  it("enables exactly nine tools and disables the other 33", () => {
    expect(COMMONPOST_ENABLED_TOOLS).toHaveLength(9);
    expect(COMMONPOST_DISABLED_TOOLS).toHaveLength(33);
    expect([...COMMONPOST_ENABLED_TOOLS, ...COMMONPOST_DISABLED_TOOLS].toSorted()).toEqual(
      [...COMMONPOST_KNOWN_TOOLS].toSorted(),
    );
  });

  it("keeps every send, forward and delete path switched off", () => {
    for (const name of [
      "sendMail",
      "forwardMessage",
      "deleteMessages",
      "deleteFolder",
      "emptyTrash",
      "emptyJunk",
      "updateMessage",
      "moveFolder",
    ]) {
      expect(COMMONPOST_DISABLED_TOOLS).toContain(name);
      expect(COMMONPOST_TOOLS as ReadonlyArray<string>).not.toContain(name);
    }
  });

  it("names exactly the tools the recorded reply from the add-on lists, plus the one it cannot hide", () => {
    const listed = recorded().result.tools.map((tool) => tool.name);
    expect(listed).toEqual([
      "listAccounts",
      "listFolders",
      "searchMessages",
      "getMessage",
      "getMessages",
      "saveDraft",
      "replyToMessage",
      "getRecentMessages",
      "getAccountAccess",
    ]);
    expect([...listed].toSorted()).toEqual([...COMMONPOST_ENABLED_TOOLS].toSorted());
  });

  it("matches the pinned schema fingerprint to the recorded reply", () => {
    expect(toolsFingerprint(recorded().result.tools)).toBe(COMMONPOST_TOOLS_FINGERPRINT);
    expect(COMMONPOST_REVIEWED_SCHEMA).toContain(COMMONPOST_TOOLS_FINGERPRINT.slice(0, 16));
  });

  it("changes the fingerprint when an argument schema changes", () => {
    const tools = recorded().result.tools.map((tool) =>
      tool.name === "saveDraft"
        ? { ...tool, inputSchema: { type: "object", properties: { extra: { type: "string" } } } }
        : tool,
    );
    expect(toolsFingerprint(tools)).not.toBe(COMMONPOST_TOOLS_FINGERPRINT);
  });

  it("keeps the fingerprint when only a description changes", () => {
    const tools = recorded().result.tools.map((tool) => ({ ...tool, description: "reworded" }));
    expect(toolsFingerprint(tools)).toBe(COMMONPOST_TOOLS_FINGERPRINT);
  });
});
