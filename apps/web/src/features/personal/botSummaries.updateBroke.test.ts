import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { PersonalBot, type PersonalBotThread, type ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  botStatus,
  buildBotSummaries,
  conversationHeaderParts,
  conversationHeaderStatus,
} from "./botSummaries";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);
const NOW = Date.parse("2026-09-15T10:00:00.000Z");

const nova = decodeBot({
  botId: "nova",
  name: "Nova",
  title: "",
  description: "",
  instructions: "",
  avatarShape: "blob",
  avatarColor: "#1A73E8",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
  enabled: true,
  sortOrder: 0,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
});
const link = {
  botId: "nova",
  threadId: "t1",
  createdAt: "2026-09-01T10:00:00.000Z",
  archivedAt: null,
} as unknown as PersonalBotThread;

const shell = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "t1",
    title: "Chat",
    updatedAt: "2026-09-15T09:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const claude = (version: string, testedVersion: string) =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    version,
    smokeCheck: {
      status: "failed",
      version: testedVersion,
      checkedAt: "2026-09-15T09:30:00.000Z",
      message: "API Error: 500",
    },
  }) as unknown as ServerProvider;

const statusFor = (threadShell: EnvironmentThreadShell, provider: ServerProvider) =>
  botStatus(
    buildBotSummaries({
      bots: [nova],
      links: [link],
      shells: [threadShell],
      providers: [provider],
    })[0]!,
    NOW,
  );

describe("Update broke", () => {
  const broken = claude("2.1.264", "2.1.264");

  it("ranks above Ready and Working, below the needs-you states", () => {
    expect(statusFor(shell(), broken)).toEqual({
      label: "Update broke Claude Code",
      tone: "review",
    });
    expect(statusFor(shell({ session: { status: "running" } }), broken).label).toBe(
      "Update broke Claude Code",
    );
    expect(statusFor(shell({ hasPendingApprovals: true }), broken).label).toBe("Needs approval");
    expect(statusFor(shell({ hasPendingUserInput: true }), broken).label).toBe("Needs your reply");
  });

  it("ignores a failed test of a version that is no longer installed", () => {
    expect(statusFor(shell(), claude("2.1.265", "2.1.264")).label).toBe("Ready");
  });

  it("replaces the chat header state unless the bot waits on the user", () => {
    const provider = { label: "Claude Code", available: true, broken: true };
    expect(conversationHeaderStatus("idle", "Idle", provider)).toBe("Update broke Claude Code");
    expect(conversationHeaderStatus("waiting", "Waiting for you", provider)).toBe(
      "Claude Code · Waiting for you",
    );
    expect(conversationHeaderStatus("idle", "Idle", { ...provider, broken: false })).toBe(
      "Claude Code · Idle",
    );
    expect(conversationHeaderStatus("idle", "Idle", null)).toBe("Idle");
  });

  it("keeps the live status apart from the provider so it never truncates", () => {
    const provider = { label: "Claude Code", available: true, broken: false };
    // The header renders `status` in its own shrink-0 span; sharing one span
    // with the provider is what turned "Waiting for you" into "Wait…".
    expect(conversationHeaderParts("waiting", "Waiting for you", provider)).toEqual({
      prefix: "Claude Code",
      status: "Waiting for you",
    });
    expect(conversationHeaderParts("idle", "Idle", null)).toEqual({ prefix: null, status: "Idle" });
    expect(conversationHeaderParts("idle", "Idle", { ...provider, broken: true })).toEqual({
      prefix: null,
      status: "Update broke Claude Code",
    });
  });
});
