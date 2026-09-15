import { PersonalBot, type ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildProviderUpdateRows, providerUpdateRow } from "./providerUpdateRows";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);

function bot(botId: string, instanceId: string, sortOrder: number) {
  return decodeBot({
    botId,
    name: botId,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId, model: "some-model" },
    enabled: true,
    sortOrder,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  });
}

function claude(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.1.263",
    ...overrides,
  } as unknown as ServerProvider;
}

const advisory = (overrides: Record<string, unknown> = {}) =>
  ({
    status: "behind_latest",
    currentVersion: "2.1.263",
    latestVersion: "2.1.264",
    updateCommand: "claude update",
    canUpdate: true,
    checkedAt: null,
    message: null,
    ...overrides,
  }) as NonNullable<ServerProvider["versionAdvisory"]>;

const updateState = (status: string, message: string | null = null) =>
  ({ status, startedAt: null, finishedAt: null, message, output: null }) as NonNullable<
    ServerProvider["updateState"]
  >;

describe("providerUpdateRow", () => {
  it("says what is installed, or that the version was not reported", () => {
    expect(providerUpdateRow(claude(), "Claude Code").version).toBe("Version 2.1.263");
    expect(providerUpdateRow(claude({ version: null }), "Claude Code").version).toBe(
      "Version not reported",
    );
    expect(providerUpdateRow(claude({ installed: false }), "Claude Code").version).toBe(
      "Not installed",
    );
  });

  it("offers the one-click update only when upstream can run it", () => {
    const oneClick = providerUpdateRow(claude({ versionAdvisory: advisory() }), "Claude Code");
    expect(oneClick.status).toEqual({ text: "Update available 2.1.264", tone: "normal" });
    expect(oneClick.canUpdate).toBe(true);
    expect(oneClick.detail).toBeNull();

    const manual = providerUpdateRow(
      claude({ versionAdvisory: advisory({ canUpdate: false, updateCommand: null }) }),
      "Claude Code",
    );
    expect(manual.canUpdate).toBe(false);
    expect(manual.detail).toBe("Update it on your computer.");
  });

  it("shows queued, running and failed updates from the update state", () => {
    const running = providerUpdateRow(
      claude({ versionAdvisory: advisory(), updateState: updateState("running") }),
      "Claude Code",
    );
    expect(running.status?.text).toBe("Updating…");
    expect(running).toMatchObject({ busy: true, canUpdate: false, canCheck: false });

    const queued = providerUpdateRow(
      claude({ versionAdvisory: advisory(), updateState: updateState("queued") }),
      "Claude Code",
    );
    expect(queued.status?.text).toBe("Waiting for another update to finish");
    expect(queued.busy).toBe(true);

    const failed = providerUpdateRow(
      claude({ updateState: updateState("failed", "Update command exited with code 1.") }),
      "Claude Code",
    );
    expect(failed.status).toEqual({ text: "Update failed", tone: "review" });
    expect(failed.detail).toBe("Update command exited with code 1.");
  });

  it("reads Update broke only for a failed test of the installed version", () => {
    const failedCheck = {
      status: "failed",
      version: "2.1.264",
      checkedAt: "2026-09-15T10:00:00.000Z",
      message: "API Error: 500",
    } as const;
    const broken = providerUpdateRow(
      claude({ version: "2.1.264", smokeCheck: failedCheck }),
      "Claude Code",
    );
    expect(broken.status).toEqual({ text: "Update broke Claude Code", tone: "review" });
    expect(broken.detail).toBe("API Error: 500");
    expect(broken.canCheck).toBe(true);

    const newer = providerUpdateRow(
      claude({ version: "2.1.265", smokeCheck: failedCheck }),
      "Claude Code",
    );
    expect(newer.status).toBeNull();

    const checking = providerUpdateRow(
      claude({
        version: "2.1.264",
        smokeCheck: { status: "checking", version: "2.1.264", checkedAt: null, message: null },
      }),
      "Claude Code",
    );
    expect(checking.status?.text).toBe("Testing 2.1.264 with one message…");
    expect(checking.canCheck).toBe(false);
  });
});

describe("buildProviderUpdateRows", () => {
  it("lists each provider a bot uses once, in bot order, including missing ones", () => {
    const rows = buildProviderUpdateRows(
      [
        claude(),
        {
          ...claude(),
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
        } as unknown as ServerProvider,
      ],
      [
        bot("b2", "codex", 1),
        bot("b1", "claudeAgent", 0),
        bot("b3", "claudeAgent", 2),
        bot("b4", "cursor", 3),
      ],
    );
    expect(rows.map((row) => [row.instanceId, row.label])).toEqual([
      ["claudeAgent", "Claude Code"],
      ["codex", "Codex"],
      ["cursor", "Cursor"],
    ]);
    expect(rows[2]).toMatchObject({
      version: "Not set up on this computer",
      canUpdate: false,
      canCheck: false,
    });
  });
});
