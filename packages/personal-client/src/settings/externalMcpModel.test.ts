import type { PersonalExternalMcpServer, PersonalExternalMcpServerId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";

import {
  applyExecutorPreset,
  draftFromExternalMcpServer,
  emptyExternalMcpDraft,
  EXECUTOR_LOCAL_PRESET,
  formatExternalMcpScopeBadge,
  formatExternalMcpTestResult,
  formatExternalMcpTokenStatus,
  hasExternalMcpDraftErrors,
  slugFromDisplayName,
  validateExternalMcpDraft,
  validateExternalMcpSlug,
  validateExternalMcpUrl,
} from "./externalMcpModel.ts";

describe("externalMcpModel", () => {
  it("provides the local Executor preset", () => {
    const draft = applyExecutorPreset(emptyExternalMcpDraft());
    expect(draft).toEqual({
      displayName: "Executor",
      slug: "executor",
      url: "http://127.0.0.1:4400/mcp",
      scope: "shared",
      scopeId: null,
    });
    expect(EXECUTOR_LOCAL_PRESET.url).toBe("http://127.0.0.1:4400/mcp");
    expect(hasExternalMcpDraftErrors(validateExternalMcpDraft(draft))).toBe(false);
  });

  it("validates slug format and rejects t3-code reserved prefix", () => {
    expect(validateExternalMcpSlug("executor")).toBeNull();
    expect(validateExternalMcpSlug("my_mcp-1")).toBeNull();
    expect(validateExternalMcpSlug("")).not.toBeNull();
    expect(validateExternalMcpSlug("UpperCase")).not.toBeNull();
    expect(validateExternalMcpSlug("-leading-dash")).not.toBeNull();
    expect(validateExternalMcpSlug("a".repeat(33))).not.toBeNull();
    expect(validateExternalMcpSlug("t3-code")).not.toBeNull();
    expect(validateExternalMcpSlug("t3-code-extra")).not.toBeNull();
  });

  it("validates URLs for https and loopback http only", () => {
    expect(validateExternalMcpUrl("https://mcp.example.com/v1")).toBeNull();
    expect(validateExternalMcpUrl("http://127.0.0.1:4400/mcp")).toBeNull();
    expect(validateExternalMcpUrl("http://localhost:4400/mcp")).toBeNull();
    expect(validateExternalMcpUrl("http://[::1]:4400/mcp")).toBeNull();

    expect(validateExternalMcpUrl("http://example.com/mcp")).not.toBeNull();
    expect(validateExternalMcpUrl("http://192.168.1.50:4400/mcp")).not.toBeNull();
    expect(validateExternalMcpUrl("ftp://example.com/mcp")).not.toBeNull();
    expect(validateExternalMcpUrl("https://user:pass@mcp.example.com/mcp")).not.toBeNull();
    expect(
      validateExternalMcpUrl("http://127.0.0.1:3773/api/personal/external-mcp/abc/mcp"),
    ).not.toBeNull();
    expect(validateExternalMcpUrl("not a url")).not.toBeNull();
  });

  it("requires scopeId for team and bot scopes but not shared", () => {
    const base = applyExecutorPreset(emptyExternalMcpDraft());

    expect(validateExternalMcpDraft({ ...base, scope: "shared", scopeId: null })).toEqual({});
    expect(validateExternalMcpDraft({ ...base, scope: "team", scopeId: null }).scopeId).toBe(
      "Choose a team.",
    );
    expect(validateExternalMcpDraft({ ...base, scope: "team", scopeId: "dev" })).toEqual({});
    expect(validateExternalMcpDraft({ ...base, scope: "bot", scopeId: "" }).scopeId).toBe(
      "Choose a bot.",
    );
    expect(validateExternalMcpDraft({ ...base, scope: "bot", scopeId: "bot-1" })).toEqual({});
  });

  it("rejects empty or overlong display names", () => {
    const base = applyExecutorPreset(emptyExternalMcpDraft());
    expect(validateExternalMcpDraft({ ...base, displayName: "   " }).displayName).toBe(
      "Enter a display name.",
    );
    expect(
      validateExternalMcpDraft({ ...base, displayName: "x".repeat(81) }).displayName,
    ).toContain("80");
  });

  it("formats scope badges for shared, team and bot scopes", () => {
    expect(formatExternalMcpScopeBadge("shared", null)).toBe("Shared");
    expect(formatExternalMcpScopeBadge("team", "dev")).toBe("Team: Dev team");
    expect(formatExternalMcpScopeBadge("team", "Research")).toBe("Team: Research");
    expect(
      formatExternalMcpScopeBadge("bot", "bot-1", {
        botName: (id) => (id === "bot-1" ? "Neon" : undefined),
      }),
    ).toBe("Bot: Neon");
    expect(formatExternalMcpScopeBadge("bot", "bot-unknown")).toBe("Bot: bot-unknown");
  });

  it("formats token status and test connection results", () => {
    expect(formatExternalMcpTokenStatus(true)).toBe("Token saved");
    expect(formatExternalMcpTokenStatus(false)).toBe("No token");

    expect(
      formatExternalMcpTestResult({ ok: true, serverName: "executor", serverVersion: "1.2.0" }),
    ).toEqual({ ok: true, text: "Connected to executor (1.2.0)" });
    expect(formatExternalMcpTestResult({ ok: true, serverName: "executor" })).toEqual({
      ok: true,
      text: "Connected to executor",
    });
    expect(formatExternalMcpTestResult({ ok: true })).toEqual({
      ok: true,
      text: "Connected",
    });
    expect(formatExternalMcpTestResult({ ok: false, error: "Connection refused" })).toEqual({
      ok: false,
      text: "Connection refused",
    });
    expect(formatExternalMcpTestResult({ ok: false, statusCode: 401 })).toEqual({
      ok: false,
      text: "Connection failed (HTTP 401)",
    });
    expect(formatExternalMcpTestResult({ ok: false })).toEqual({
      ok: false,
      text: "Connection failed",
    });
  });

  it("derives slugs and converts server records into drafts", () => {
    expect(slugFromDisplayName("My Local Executor!")).toBe("my-local-executor");
    expect(slugFromDisplayName("  ---Demo 2  ")).toBe("demo-2");

    const now = DateTime.makeUnsafe("2026-11-26T22:00:00.000Z");
    const server: PersonalExternalMcpServer = {
      serverId: "srv-1" as PersonalExternalMcpServerId,
      slug: "executor",
      displayName: "Executor",
      url: "http://127.0.0.1:4400/mcp",
      scope: "team",
      scopeId: "dev",
      enabled: true,
      hasToken: true,
      createdAt: now,
      updatedAt: now,
    };
    expect(draftFromExternalMcpServer(server)).toEqual({
      displayName: "Executor",
      slug: "executor",
      url: "http://127.0.0.1:4400/mcp",
      scope: "team",
      scopeId: "dev",
    });
  });
});
