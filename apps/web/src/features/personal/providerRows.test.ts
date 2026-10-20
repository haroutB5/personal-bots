import { PersonalBot, type ProviderInstallState, type ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  botsUseText,
  buildProviderList,
  providerRow,
  withPendingAction,
  type ProviderRow,
} from "./providerRows";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);

function bot(name: string, instanceId: string, sortOrder: number, model = "some-model") {
  return decodeBot({
    botId: name.toLowerCase(),
    name,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId, model },
    enabled: true,
    sortOrder,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  });
}

function provider(overrides: Record<string, unknown> = {}): ServerProvider {
  return {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.1.303",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-20T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as unknown as ServerProvider;
}

const advisory = (overrides: Record<string, unknown> = {}) => ({
  status: "behind_latest",
  currentVersion: "2.1.303",
  latestVersion: "0.164.0",
  updateCommand: "claude update",
  canUpdate: true,
  checkedAt: null,
  message: null,
  ...overrides,
});

const updateState = (status: string, message: string | null = null) => ({
  status,
  startedAt: null,
  finishedAt: null,
  message,
  output: null,
});

const smoke = (overrides: Record<string, unknown>) => ({
  status: "passed",
  version: "2.1.303",
  checkedAt: "2026-10-20T10:00:00.000Z",
  message: null,
  ...overrides,
});

const NOW = new Date("2026-10-20T10:30:00.000Z");

function rowOf(
  snapshot: ServerProvider,
  options: { bots?: ReadonlyArray<PersonalBot>; install?: ProviderInstallState | null } = {},
): ProviderRow {
  return providerRow({
    snapshot,
    label: "Claude Code",
    bots: options.bots ?? [],
    install: options.install ?? null,
    now: NOW,
  });
}

const install = (overrides: Record<string, unknown>): ProviderInstallState =>
  ({
    driver: "antigravity",
    operationId: "op-1",
    phase: "downloading",
    downloadedBytes: 46_000_000,
    totalBytes: 99_000_000,
    version: "1.4.1",
    installedVersion: null,
    canRemove: false,
    message: null,
    ...overrides,
  }) as ProviderInstallState;

describe("provider row states (SPEC 3.3, first match wins, at most one action)", () => {
  it("1 Installing: progress, no action", () => {
    const row = rowOf(provider({ installed: false, setup: { canInstall: true } }), {
      install: install({}),
    });
    expect(row).toMatchObject({
      state: "installing",
      statusText: "Installing · 46 of 99 MB",
      dot: "none",
      action: null,
      busy: true,
    });
    expect(row.progress?.fraction).toBeCloseTo(46 / 99);
    expect(
      rowOf(provider({ installed: false }), { install: install({ totalBytes: null }) }).statusText,
    ).toBe("Installing…");
    expect(rowOf(provider(), { install: install({ phase: "extracting" }) }).statusText).toBe(
      "Unpacking…",
    );
    expect(rowOf(provider(), { install: install({ phase: "verifying" }) }).statusText).toBe(
      "Checking it starts…",
    );
  });

  it("2 Updating, 3 Testing", () => {
    expect(
      rowOf(provider({ versionAdvisory: advisory(), updateState: updateState("running") })),
    ).toMatchObject({ state: "updating", statusText: "Updating to 0.164.0…", action: null });
    expect(rowOf(provider({ updateState: updateState("queued") })).statusText).toBe(
      "Waiting for another update to finish",
    );
    expect(rowOf(provider({ smokeCheck: smoke({ status: "checking" }) }))).toMatchObject({
      state: "testing",
      dot: "spinner",
      statusText: "Testing 2.1.303 with one message…",
    });
  });

  it("5 Install failed and 6 Won't start: Try again", () => {
    const failed = rowOf(provider({ installed: false, setup: { canInstall: true } }), {
      install: install({ phase: "failed", message: "Your laptop lost its connection.\nmore" }),
    });
    expect(failed).toMatchObject({
      state: "installFailed",
      statusText: "Install failed",
      detail: "Your laptop lost its connection.",
      action: { kind: "tryAgain", label: "Try again" },
      dot: "error",
    });
    expect(rowOf(provider({ status: "error", message: "unsupported platform" }))).toMatchObject({
      state: "wontStart",
      statusText: "Installed, but it won't start",
      detail: "unsupported platform",
      action: { kind: "tryAgain" },
    });
  });

  it("7 Update broke offers Go back only when the previous version is kept and installable", () => {
    const broken = smoke({
      status: "failed",
      version: "1.19.3",
      message: "m: Unexpected server error",
      previousVersion: "1.19.2",
    });
    const withGoBack = rowOf(
      provider({
        version: "1.19.3",
        smokeCheck: broken,
        versionAdvisory: advisory({ canInstallVersion: true, status: "current" }),
      }),
    );
    expect(withGoBack).toMatchObject({
      state: "updateBroke",
      statusText: "Update broke Claude Code",
      detail: "1.19.3 failed the test message. 1.19.2 worked.",
      action: { kind: "goBack", label: "Go back" },
    });
    const noInstaller = rowOf(provider({ version: "1.19.3", smokeCheck: broken }));
    expect(noInstaller.action).toEqual({ kind: "testAgain", label: "Test again" });
    // A verdict about another version says nothing about the installed one.
    expect(rowOf(provider({ version: "1.19.4", smokeCheck: broken })).state).toBe("ready");
  });

  it("a failed Test of the owner is not blamed on an update", () => {
    const row = rowOf(
      provider({
        smokeCheck: smoke({ status: "failed", manual: true, message: "m: model not found" }),
      }),
    );
    expect(row).toMatchObject({
      state: "testFailed",
      statusText: "Test message failed",
      action: { kind: "testAgain" },
    });
  });

  it("8 Model gone: the test passed, the bots' model is gone, Fix", () => {
    const row = rowOf(
      provider({ smokeCheck: smoke({ missingModels: ["opencode/muse-spark-1.3"] }) }),
      {
        bots: [
          bot("Watcher", "claudeAgent", 0, "opencode/muse-spark-1.3"),
          bot("Musey", "claudeAgent", 1, "opencode/muse-spark-1.3"),
          bot("Scout", "claudeAgent", 2, "other"),
        ],
      },
    );
    expect(row).toMatchObject({
      state: "modelGone",
      dot: "review",
      statusText: "A model your bots use is gone",
      detail: "Claude Code dropped opencode/muse-spark-1.3. Watcher and Musey use it.",
      action: { kind: "fix", label: "Fix" },
    });
  });

  it("9 Needs sign-in and 10 Not installed with the bots that use it", () => {
    expect(rowOf(provider({ auth: { status: "unauthenticated" } }))).toMatchObject({
      state: "needsSignIn",
      statusText: "Sign in to use it",
      action: { kind: "signIn", label: "Sign in" },
    });
    // A provider the app signs in itself reports "unknown" until a sign-in was tried.
    expect(
      rowOf(provider({ auth: { status: "unknown" }, setup: { canAuthenticate: true } })).state,
    ).toBe("needsSignIn");
    expect(rowOf(provider({ auth: { status: "unknown" } })).state).toBe("ready");
    const notInstalled = rowOf(provider({ installed: false, setup: { canInstall: true } }), {
      bots: [bot("Musey", "claudeAgent", 0), bot("Scout", "claudeAgent", 1)],
    });
    expect(notInstalled).toMatchObject({
      state: "notInstalled",
      statusText: "Not installed · Musey and Scout use it",
      action: { kind: "install", label: "Install" },
    });
    expect(botsUseText(["A"])).toBe("A uses it");
    expect(botsUseText(["A", "B", "C"])).toBe("3 bots use it");
    // No installer from the phone: no action, a plain line.
    expect(
      rowOf(provider({ installed: false }), { bots: [bot("Musey", "claudeAgent", 0)] }),
    ).toMatchObject({ action: null, detail: "Install it on your computer." });
  });

  it("11 Update failed, 12 waiting for the limit, 13 low balance", () => {
    expect(rowOf(provider({ updateState: updateState("failed", "exit code 1") }))).toMatchObject({
      state: "updateFailed",
      statusText: "Update failed",
      detail: "exit code 1",
      action: { kind: "tryAgain" },
    });
    expect(
      rowOf(
        provider({
          smokeCheck: smoke({ status: "waiting_for_limit", retryAt: "2026-10-20T11:47:00.000Z" }),
        }),
      ),
    ).toMatchObject({ state: "waitingForLimit", dot: "waiting", action: null });
    expect(
      rowOf(
        provider({
          usageBalance: {
            checkedAt: "2026-10-20T10:00:00.000Z",
            status: "ready",
            balance: {
              currency: "USD",
              totalBalance: 0.84,
              grantedBalance: 0,
              toppedUpBalance: 0.84,
              isAvailable: true,
              fetchedAt: "2026-10-20T10:00:00.000Z",
            },
          },
        }),
      ),
    ).toMatchObject({
      state: "lowBalance",
      statusText: "Balance $0.84 · top up soon",
      action: null,
    });
  });

  it("14 Update available (primary), 15 Off, 16 Ready", () => {
    expect(rowOf(provider({ versionAdvisory: advisory() }))).toMatchObject({
      state: "updateAvailable",
      statusText: "New version 0.164.0",
      action: { kind: "update", label: "Update" },
      detail: null,
    });
    expect(
      rowOf(provider({ versionAdvisory: advisory({ canUpdate: false, updateCommand: null }) })),
    ).toMatchObject({
      action: null,
      detail: "Update it on your computer.",
    });
    expect(rowOf(provider({ enabled: false }))).toMatchObject({
      state: "off",
      dot: "off",
      statusText: "Off · bots can't use it",
      action: null,
    });
    expect(rowOf(provider({ versionAdvisory: advisory({ status: "current" }) }))).toMatchObject({
      state: "ready",
      statusText: "Version 2.1.303 · Up to date",
      dot: "live",
    });
    expect(rowOf(provider()).statusText).toBe("Version 2.1.303");
  });

  it("no row ever has more than one action", () => {
    const rows = [
      rowOf(provider({ versionAdvisory: advisory() })),
      rowOf(provider({ auth: { status: "unauthenticated" } })),
      rowOf(provider({ updateState: updateState("failed", "x") })),
    ];
    for (const row of rows)
      expect(row.action === null || typeof row.action.kind === "string").toBe(true);
  });
});

describe("withPendingAction", () => {
  it("answers a tap at once and lets the server's own busy state win", () => {
    const ready = rowOf(provider({ versionAdvisory: advisory() }));
    expect(withPendingAction(ready, { kind: "update" })).toMatchObject({
      statusText: "Starting update…",
      action: null,
      busy: true,
    });
    expect(withPendingAction(ready, { kind: "check" }).statusText).toBe("Checking…");
    expect(withPendingAction(ready, { kind: "install" }).statusText).toBe("Starting install…");
    expect(withPendingAction(ready, { kind: "signIn" }).statusText).toBe("Starting sign-in…");
    expect(withPendingAction(ready, { kind: "removing" })).toMatchObject({
      statusText: "Removing…",
      dot: "spinner",
    });
    expect(withPendingAction(ready, { kind: "goBack", version: "1.19.2" }).statusText).toBe(
      "Going back to 1.19.2…",
    );
    const updating = rowOf(provider({ updateState: updateState("running") }));
    expect(withPendingAction(updating, { kind: "check" })).toBe(updating);
    expect(withPendingAction(ready, null)).toBe(ready);
  });
});

describe("buildProviderList (SPEC 3.2)", () => {
  const claude = provider();
  const codex = provider({ instanceId: "codex", driver: "codex", displayName: "Codex" });
  const antigravity = provider({
    instanceId: "antigravity",
    driver: "antigravity",
    displayName: "Antigravity",
    installed: false,
    setup: { canInstall: true, canAuthenticate: true },
  });
  const cursor = provider({
    instanceId: "cursor",
    driver: "cursor",
    displayName: "Cursor",
    installed: false,
  });

  it("lists bots' providers first, then installed ones; the rest are addable", () => {
    const list = buildProviderList(
      [antigravity, claude, cursor, codex],
      [bot("Scout", "codex", 0)],
      new Map(),
      NOW,
    );
    expect(list.rows.map((row) => row.instanceId)).toEqual(["codex", "claudeAgent"]);
    expect(list.addable.map((row) => row.instanceId)).toEqual(["antigravity", "cursor"]);
  });

  it("a provider being installed, or whose install failed, appears at once", () => {
    const installing = new Map([["antigravity", install({})]]);
    const list = buildProviderList([antigravity, claude], [], installing, NOW);
    expect(list.rows.map((row) => [row.instanceId, row.state])).toEqual([
      ["antigravity", "installing"],
      ["claudeAgent", "ready"],
    ]);
    const failed = buildProviderList(
      [antigravity],
      [],
      new Map([["antigravity", install({ phase: "failed", message: "x" })]]),
      NOW,
    );
    expect(failed.rows[0]?.state).toBe("installFailed");
  });

  it("a provider a bot uses through its fallback is listed, and a missing one still gets a row", () => {
    const withFallback = decodeBot({
      ...bot("Scout", "claudeAgent", 0),
      modelSelection: { instanceId: "claudeAgent", model: "m" },
      fallback: { enabled: true, modelSelection: { instanceId: "cursor", model: "auto" } },
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    });
    const list = buildProviderList(
      [claude, cursor],
      [withFallback, bot("Ghost", "gone", 1)],
      new Map(),
      NOW,
    );
    expect(list.rows.map((row) => row.instanceId)).toEqual(["claudeAgent", "cursor", "gone"]);
    expect(list.rows[2]).toMatchObject({
      driver: null,
      statusText: "Not set up on this computer",
    });
    expect(list.rows[1]?.state).toBe("notInstalled");
  });
});

describe("canToggleUsage on ProviderRow", () => {
  it("marks installed and signed in providers with usage as canToggleUsage", () => {
    const row = providerRow({
      snapshot: provider({
        driver: "antigravity",
        installed: true,
        auth: { status: "authenticated" },
      }),
      label: "Google Antigravity",
      bots: [],
      install: null,
      now: new Date(NOW),
    });
    expect(row.canToggleUsage).toBe(true);

    const pending = withPendingAction(row, { kind: "check" });
    expect(pending.canToggleUsage).toBe(true);
  });

  it("marks unauthenticated or uninstalled providers as not eligible for usage toggle", () => {
    const unauth = providerRow({
      snapshot: provider({
        driver: "antigravity",
        installed: true,
        auth: { status: "unauthenticated" },
      }),
      label: "Google Antigravity",
      bots: [],
      install: null,
      now: new Date(NOW),
    });
    expect(unauth.canToggleUsage).toBe(false);
  });
});
