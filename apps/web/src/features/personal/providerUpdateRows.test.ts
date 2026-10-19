import { PersonalBot, type ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderUpdateRows,
  providerUpdateRow,
  withPendingAction,
} from "./providerUpdateRows";

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

describe("a usage limit is not a broken update", () => {
  const waiting = {
    status: "waiting_for_limit",
    version: "2.1.264",
    checkedAt: "2026-10-16T07:10:00.000Z",
    message: "gpt-6-astra: ERROR: You've hit your usage limit.",
    retryAt: "2026-10-16T11:47:00.000Z",
  } as const;
  // 12:47 London time (BST), later the same day.
  const NOW = new Date("2026-10-16T08:52:00.000Z");

  it("says the test waits and when it retries, never Update broke", () => {
    const row = providerUpdateRow(
      claude({ version: "2.1.264", smokeCheck: waiting }),
      "Codex",
      NOW,
    );
    expect(row.status).toEqual({
      text: "Update test waits for the usage limit (retries 12:47)",
      tone: "normal",
    });
    expect(row.detail).toBeNull();
    expect(row.canCheck).toBe(true);
    expect(row.busy).toBe(false);
    expect(JSON.stringify(row)).not.toContain("Update broke");
  });

  it("adds the weekday when the retry is not today, and copes with no time", () => {
    const tomorrow = providerUpdateRow(
      claude({
        version: "2.1.264",
        smokeCheck: { ...waiting, retryAt: "2026-10-17T07:30:00.000Z" },
      }),
      "Codex",
      NOW,
    );
    expect(tomorrow.status?.text).toBe("Update test waits for the usage limit (retries Sat 08:30)");
    const { retryAt: _retryAt, ...unknown } = waiting;
    const noTime = providerUpdateRow(
      claude({ version: "2.1.264", smokeCheck: unknown }),
      "Codex",
      NOW,
    );
    expect(noTime.status).toEqual({
      text: "Update test waits for the usage limit",
      tone: "normal",
    });
  });

  it("ignores a wait recorded for a version that is no longer installed", () => {
    const row = providerUpdateRow(
      claude({ version: "2.1.265", smokeCheck: waiting }),
      "Codex",
      NOW,
    );
    expect(row.status).toBeNull();
  });
});

describe("withPendingAction", () => {
  it("answers a tap at once, before the snapshot catches up", () => {
    // Check again refreshes the provider first (seconds) before the server
    // publishes its checking state; the row must not look untouched.
    const row = providerUpdateRow(claude({ versionAdvisory: advisory() }), "Claude Code");
    expect(withPendingAction(row, "check")).toMatchObject({
      status: { text: "Checking…", tone: "normal" },
      canCheck: false,
      canUpdate: false,
    });
    expect(withPendingAction(row, "update").status?.text).toBe("Starting update…");
    expect(withPendingAction(row, null)).toBe(row);
  });

  it("lets the server's own state win once it arrives", () => {
    const checking = providerUpdateRow(
      claude({
        smokeCheck: { status: "checking", version: "2.1.263", checkedAt: null, message: null },
      }),
      "Claude Code",
    );
    expect(withPendingAction(checking, "check").status?.text).toBe(
      "Testing 2.1.263 with one message…",
    );
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

  it("still lists a provider on this computer that no bot uses", () => {
    // Deleting the last Codex bot used to take away the only place to update
    // the Codex CLI, while the usage strip went on reporting Codex usage.
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
      [bot("b1", "claudeAgent", 0)],
    );
    expect(rows.map((row) => row.instanceId)).toEqual(["claudeAgent", "codex"]);
    // A real row, not a placeholder: it is installed, so it can be checked.
    expect(rows[1]).toMatchObject({ canCheck: true });
  });
});

describe("the Show usage switch", () => {
  const signedIn = { status: "authenticated" } as ServerProvider["auth"];

  it("is offered only for a provider that is installed, signed in and has usage", () => {
    expect(providerUpdateRow(claude({ auth: signedIn }), "Claude Code").canToggleUsage).toBe(true);
    expect(
      providerUpdateRow(claude({ auth: { status: "unauthenticated" } }), "Claude Code")
        .canToggleUsage,
    ).toBe(false);
    expect(
      providerUpdateRow(claude({ auth: signedIn, installed: false }), "Claude Code").canToggleUsage,
    ).toBe(false);
    // A driver with no usage card shows it only once it reports windows.
    const grok = claude({ instanceId: "grok", driver: "grok", auth: signedIn } as never);
    expect(providerUpdateRow(grok, "Grok").canToggleUsage).toBe(false);
    const grokWithWindows = {
      ...grok,
      usageLimits: {
        checkedAt: "2026-10-19T21:00:00.000Z",
        windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 4 }],
      },
    } as ServerProvider;
    expect(providerUpdateRow(grokWithWindows, "Grok").canToggleUsage).toBe(true);
    expect(buildProviderUpdateRows([], [bot("a", "missing", 0)])[0]!.canToggleUsage).toBe(false);
  });
});
