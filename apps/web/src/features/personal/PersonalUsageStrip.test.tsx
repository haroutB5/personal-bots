import type { ReactNode } from "react";

import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PersonalUsageStrip, resetUsageAutoProbe } from "./PersonalUsageStrip";
import { resetUsageRefresh } from "./usageRefresh";

const NOW = Date.parse("2026-09-13T12:00:00Z");

const state = vi.hoisted(() => ({
  providers: [] as unknown[],
  refresh: (() => {}) as (...args: unknown[]) => unknown,
  consume: (() => {}) as (...args: unknown[]) => unknown,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("~/state/server", () => ({
  primaryServerProvidersAtom: {},
  serverEnvironment: {
    refreshProviders: { label: "refreshProviders" },
    consumeResetCredit: { label: "consumeResetCredit" },
  },
}));
// Never the real RPC: a redeem spends one of the owner's banked resets.
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => (value: unknown) =>
    command.label === "consumeResetCredit" ? state.consume(value) : state.refresh(value),
}));
vi.mock("~/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-slot="alert-dialog">{children}</div> : null,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogClose: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("./usePersonalBots", () => ({ usePersonalEnvironmentId: () => "env-1" }));
vi.mock("~/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-slot="sheet">{children}</div> : null,
  SheetPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetClose: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

function provider(driver: string, usageLimits: unknown, usageBalance?: unknown): ServerProvider {
  return {
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T12:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
    ...(usageBalance !== undefined ? { usageBalance } : {}),
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(driver),
  } as unknown as ServerProvider;
}

const CLAUDE_WINDOWS = [
  {
    id: "five_hour",
    kind: "session",
    label: "5-hour session",
    usedPercent: 26,
    resetsAt: "2026-09-13T14:30:00Z",
  },
  {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent: 8,
    resetsAt: "2026-09-20T12:00:00Z",
  },
];
const CODEX_WINDOWS = [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 12 }];

const CLAUDE = provider("claudeAgent", {
  checkedAt: "2026-09-13T11:59:00Z",
  windows: CLAUDE_WINDOWS,
});

const CODEX = provider("codex", {
  checkedAt: "2026-09-13T11:58:00Z",
  windows: CODEX_WINDOWS,
});

let renderer: ReactTestRenderer | undefined;

/** Every string in the rendered tree, joined: vnode text splits around interpolations. */
function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node !== null && "children" in node) {
    return textOf((node as { children: unknown }).children);
  }
  return "";
}

beforeEach(() => {
  resetUsageAutoProbe();
  resetUsageRefresh();
  state.refresh = vi.fn(async () => ({ _tag: "Success", value: undefined }));
  state.consume = vi.fn(async () => ({ _tag: "Success", value: { outcome: "reset" } }));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.providers = [];
  vi.restoreAllMocks();
});

describe("PersonalUsageStrip", () => {
  // A snapshot from a server that has just restarted: the startup probe could
  // not read usage, so the provider publishes no windows at all.
  const UNREAD = () => [provider("claudeAgent", undefined), provider("codex", undefined)];

  it("takes its first usage reading itself after a restart, without the sheet being opened", async () => {
    state.providers = UNREAD();
    // The probe the strip asks for is the one the sheet asks for; when it
    // lands the server publishes real readings.
    state.refresh = vi.fn(async () => {
      state.providers = [
        provider("claudeAgent", { checkedAt: new Date().toISOString(), windows: CLAUDE_WINDOWS }),
        provider("codex", { checkedAt: new Date().toISOString(), windows: CODEX_WINDOWS }),
      ];
      return { _tag: "Success", value: undefined };
    });
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { refreshUsage: true },
    });
    // Nothing opened the sheet.
    expect(renderer!.root.findAll((node) => node.props["data-slot"] === "sheet")).toHaveLength(0);

    await act(async () => renderer!.update(<PersonalUsageStrip now={NOW} />));
    const label = renderer!.root.findAllByType("button")[0]!.props["aria-label"];
    expect(label).toBe(
      "Usage: Claude, Session 26 percent used, Weekly 8 percent used; Codex, Session 12 percent used, Weekly not reported. Open details.",
    );
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Not reported");
    // The readings arriving is not a reason to probe again.
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("probes a failed startup read even though it only just failed", async () => {
    // The provider says "could not read" with a checkedAt from seconds ago:
    // fresh by the sheet's staleness rule, but nothing to show.
    const failed = (driver: string) =>
      provider(driver, {
        checkedAt: new Date().toISOString(),
        windows: [],
        unavailable: { reason: "probeFailed" },
      });
    state.providers = [failed("claudeAgent"), failed("codex")];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { refreshUsage: true },
    });
  });

  it("does not spend a probe on fresh readings", async () => {
    const fresh = new Date().toISOString();
    state.providers = [
      provider("claudeAgent", { checkedAt: fresh, windows: CLAUDE_WINDOWS }),
      provider("codex", { checkedAt: fresh, windows: CODEX_WINDOWS }),
    ];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("asks once per probe interval while a card has nothing, not once per snapshot", async () => {
    const at = vi.spyOn(Date, "now");
    const start = Date.parse("2026-09-29T00:17:00Z");
    at.mockReturnValue(start);
    state.providers = UNREAD();
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);

    // The probe failed: fresh snapshots keep arriving with nothing read.
    for (const seconds of [10, 60, 240]) {
      at.mockReturnValue(start + seconds * 1000);
      state.providers = UNREAD();
      await act(async () => renderer!.update(<PersonalUsageStrip now={NOW} />));
    }
    expect(state.refresh).toHaveBeenCalledTimes(1);

    // One server probe interval later, still nothing: one more attempt.
    at.mockReturnValue(start + 5 * 60_000 + 1000);
    state.providers = UNREAD();
    await act(async () => renderer!.update(<PersonalUsageStrip now={NOW} />));
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not probe a good reading just because it aged, after the first load", async () => {
    const at = vi.spyOn(Date, "now");
    const start = Date.parse("2026-09-29T00:17:00Z");
    at.mockReturnValue(start);
    const reading = (ago: number) => [
      provider("claudeAgent", {
        checkedAt: new Date(start - ago).toISOString(),
        windows: CLAUDE_WINDOWS,
      }),
      provider("codex", { checkedAt: new Date(start - ago).toISOString(), windows: CODEX_WINDOWS }),
    ];
    state.providers = reading(1000);
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    expect(state.refresh).not.toHaveBeenCalled();
    at.mockReturnValue(start + 20 * 60_000);
    state.providers = reading(20 * 60_000);
    await act(async () => renderer!.update(<PersonalUsageStrip now={NOW} />));
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("renders nothing until providers arrive, so cold start never jumps", async () => {
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    expect(renderer!.toJSON()).toBeNull();
  });

  it("shows Claude left and Codex right with one labelled button", async () => {
    state.providers = [CLAUDE, CODEX];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });

    const buttons = renderer!.root.findAllByType("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props["aria-label"]).toBe(
      "Usage: Claude, Session 26 percent used, Weekly 8 percent used; Codex, Session 12 percent used, Weekly not reported. Open details.",
    );
    const json = JSON.stringify(renderer!.toJSON());
    expect(json.indexOf("Claude")).toBeLessThan(json.indexOf("Codex"));
    expect(json).toContain("26%");
    expect(json).toContain("Session");
    expect(json).toContain("Weekly");
    expect(json).toContain("used");
    expect(json).toContain("12%");
    // Chrome, not content: the sheet stays closed until asked for.
    expect(json).not.toContain("resets in");
  });

  it("says the provider did not report, never 0%, when it cannot report", async () => {
    state.providers = [
      provider("claudeAgent", {
        checkedAt: "2026-09-13T11:59:00Z",
        windows: [],
        unavailable: { reason: "unsupported" },
      }),
    ];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    const json = JSON.stringify(renderer!.toJSON());
    // Both windows missing: one plain phrase, not "Session – · Weekly – used".
    expect(json).toContain("Not reported");
    expect(json).not.toContain("0%");
  });

  it("keeps a dash for the one window a provider did not report", async () => {
    state.providers = [
      provider("claudeAgent", {
        checkedAt: "2026-09-13T11:59:00Z",
        windows: [
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 12,
            resetsAt: "2026-09-18T09:00:00Z",
          },
        ],
      }),
    ];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain("–");
    expect(json).not.toContain("0%");
  });

  it("opens the sheet on DeepSeek's balance, with the split and its age, and no strip cell", async () => {
    state.providers = [
      CLAUDE,
      CODEX,
      provider("deepseek", undefined, {
        status: "ready",
        checkedAt: "2026-09-13T11:59:00Z",
        balance: {
          currency: "USD",
          totalBalance: 12.34,
          grantedBalance: 2,
          toppedUpBalance: 10.34,
          isAvailable: true,
          fetchedAt: "2026-09-13T11:50:00Z",
        },
      }),
    ];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    // The strip stays two-up: the balance has no percent window to plot.
    expect(renderer!.root.findAllByType("button")[0]!.props["aria-label"]).toBe(
      "Usage: Claude, Session 26 percent used, Weekly 8 percent used; Codex, Session 12 percent used, Weekly not reported. Open details.",
    );
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("DeepSeek");

    await act(async () => {
      renderer!.root.findAllByType("button")[0]!.props.onClick();
    });
    const json = JSON.stringify(renderer!.toJSON());
    const text = textOf(renderer!.toJSON());
    expect(json).toContain("DeepSeek");
    expect(text).toContain("Balance left$12.34");
    expect(text).toContain("Granted $2.00 · Topped up $10.34");
    // Nothing recorded to price yet: said plainly, never a zero.
    expect(text).toContain("No DeepSeek spend recorded yet.");
    // Aged from the provider's own fetch time, not the probe's checkedAt.
    expect(text).toContain("Updated 10m");
    // The two window cards are untouched beside it.
    expect(json).toContain("26% used");
  });

  it("shows the spent figure the scan priced, beside the balance", async () => {
    state.providers = [
      CLAUDE,
      CODEX,
      provider("deepseek", undefined, {
        status: "ready",
        checkedAt: "2026-09-13T11:59:00Z",
        balance: {
          currency: "USD",
          totalBalance: 12.34,
          grantedBalance: 2,
          toppedUpBalance: 10.34,
          isAvailable: true,
          fetchedAt: "2026-09-13T11:50:00Z",
        },
        // Our own records' value at the published Flash rates, from the scan.
        spent: { costUsd: 0.9713, since: "2026-09-08T09:00:00Z", records: 650 },
      }),
    ];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    await act(async () => {
      renderer!.root.findAllByType("button")[0]!.props.onClick();
    });
    const text = textOf(renderer!.toJSON());
    expect(text).toContain("Balance left$12.34");
    expect(text).toContain("Spent $0.97 since 8 Sep");
  });

  it("says a failed balance read failed, keeping the last good numbers", async () => {
    state.providers = [
      CLAUDE,
      provider("deepseek", undefined, {
        status: "failed",
        checkedAt: "2026-09-13T11:59:00Z",
        balance: {
          currency: "USD",
          totalBalance: 3.5,
          grantedBalance: 0,
          toppedUpBalance: 3.5,
          isAvailable: true,
          fetchedAt: "2026-09-13T11:55:00Z",
        },
        message: "DeepSeek could not be reached for the balance.",
      }),
    ];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    await act(async () => {
      renderer!.root.findAllByType("button")[0]!.props.onClick();
    });
    const text = textOf(renderer!.toJSON());
    expect(text).toContain("$3.50");
    expect(text).toContain("Couldn't refresh · DeepSeek could not be reached for the balance.");
  });

  it("opens the detail sheet with every window, resets and a refresh", async () => {
    state.providers = [CLAUDE, CODEX];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    await act(async () => {
      renderer!.root.findAllByType("button")[0]!.props.onClick();
    });

    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain("Resets");
    expect(json).toContain("resets in 2h 30m");
    expect(json).toContain("resets in 7d 0h");
    expect(json).toContain("26% used");
    expect(json).toContain("Updated");
    const refresh = renderer!.root.findAll(
      (node) => node.type === "button" && node.props["aria-label"] === "Refresh usage",
    );
    expect(refresh).toHaveLength(1);

    // Refresh must re-read the limits, not get a cached probe back as "Updated now".
    vi.mocked(state.refresh).mockClear();
    await act(async () => refresh[0]!.props.onClick());
    expect(state.refresh).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { refreshUsage: true },
    });
  });

  /**
   * The reported bug: "Session 0% . Weekly 100% used" beside an empty bar,
   * because the bar tracked the 5-hour window alone. It now fills to the
   * binding window and takes the amber treatment it already uses past 80%.
   */
  it("fills the bar when the weekly allowance is spent and the session is idle", async () => {
    state.providers = [
      provider("claudeAgent", {
        checkedAt: "2026-09-13T11:59:00Z",
        windows: [
          { id: "five_hour", kind: "session", label: "5-hour session", usedPercent: 0 },
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100 },
        ],
      }),
    ];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });

    const filled = renderer!.root.findAll(
      (node) => typeof node.props.style?.width === "string" && node.props.style.width !== "0%",
    );
    expect(filled.map((node) => node.props.style.width)).toEqual(["100%"]);
    expect(filled[0]!.props.style.backgroundColor).toBe("var(--personal-review)");
    // The label still reads both numbers the bar collapses into one.
    expect(renderer!.root.findAllByType("button")[0]!.props["aria-label"]).toContain(
      "Session 0 percent used, Weekly 100 percent used",
    );
  });

  describe("banked reset credits", () => {
    function withCredits(availableCount: number): ServerProvider {
      return provider("claudeAgent", {
        ...(CLAUDE.usageLimits as object),
        resetCredits: { availableCount, nextExpiresAt: "2026-09-20T12:00:00Z" },
      });
    }

    async function openSheet() {
      await act(async () => {
        renderer = create(<PersonalUsageStrip now={NOW} />);
      });
      await act(async () => {
        renderer!.root.findAllByType("button")[0]!.props.onClick();
      });
      // The redeem block is a lazy chunk: let it resolve.
      await act(async () => {
        await import("./PersonalResetCredits");
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    function redeemButtons() {
      return renderer!.root.findAll(
        (node) =>
          node.type === "button" &&
          typeof node.props["aria-label"] === "string" &&
          node.props["aria-label"].startsWith("Redeem a banked"),
      );
    }

    it("shows nothing about resets when none are banked", async () => {
      state.providers = [withCredits(0), CODEX];
      await openSheet();
      expect(redeemButtons()).toHaveLength(0);
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("banked");
    });

    it("offers Redeem under the provider that has a banked reset", async () => {
      state.providers = [withCredits(1), CODEX];
      await openSheet();
      expect(redeemButtons().map((node) => node.props["aria-label"])).toEqual([
        "Redeem a banked Claude reset",
      ]);
      const json = JSON.stringify(renderer!.toJSON());
      expect(json).toContain("1 reset banked");
      expect(json).toContain("7d 0h");
    });

    it("redeems on confirm, then refreshes usage so the bars update", async () => {
      state.providers = [withCredits(1), CODEX];
      await openSheet();
      vi.mocked(state.refresh).mockClear();

      await act(async () => redeemButtons()[0]!.props.onClick());
      const dialog = renderer!.root.find((node) => node.props["data-slot"] === "alert-dialog");
      const confirm = dialog.find(
        (node) => node.type === "button" && node.props.children === "Redeem",
      );
      await act(async () => confirm.props.onClick());

      expect(state.consume).toHaveBeenCalledTimes(1);
      expect(state.consume).toHaveBeenCalledWith({
        environmentId: "env-1",
        input: { instanceId: "claudeAgent" },
      });
      expect(state.refresh).toHaveBeenCalledTimes(1);
      expect(state.refresh).toHaveBeenCalledWith({
        environmentId: "env-1",
        input: { refreshUsage: true },
      });
      expect(JSON.stringify(renderer!.toJSON())).toContain(
        "Reset applied. Your windows have cleared.",
      );
    });

    it("says so when the provider's figures have not caught up with the reset", async () => {
      const warning =
        "Reset applied. The provider's usage figures have not caught up yet; they will update on their own in a few minutes.";
      state.consume = vi.fn(async () => ({
        _tag: "Success",
        value: { outcome: "reset", warning },
      }));
      state.providers = [withCredits(1), CODEX];
      await openSheet();

      await act(async () => redeemButtons()[0]!.props.onClick());
      const dialog = renderer!.root.find((node) => node.props["data-slot"] === "alert-dialog");
      const confirm = dialog.find(
        (node) => node.type === "button" && node.props.children === "Redeem",
      );
      await act(async () => confirm.props.onClick());

      const json = JSON.stringify(renderer!.toJSON());
      expect(json).toContain(warning);
      expect(json).not.toContain("Your windows have cleared.");
    });
  });
});

describe("usage values never disappear", () => {
  /** Visible text only, so a failed assertion prints a line, not the whole tree. */
  function visibleText(): string {
    const parts: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") parts.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") walk((node as { children?: unknown }).children);
    };
    walk(renderer!.toJSON());
    return parts.join(" ").replace(/\s+/g, " ");
  }

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function openSheet() {
    await act(async () => {
      renderer!.root.findAllByType("button")[0]!.props.onClick();
    });
  }

  it("keeps the last reading on screen with Refreshing beside Updated while a probe runs", async () => {
    // 7 Oct 08:21: Claude had no reading, so its card said only "Checking…".
    // Now the reading persisted across the restart is old but present.
    const finishers: Array<() => void> = [];
    state.refresh = vi.fn(
      () =>
        new Promise((resolve) => {
          finishers.push(() => resolve({ _tag: "Success", value: undefined }));
        }),
    );
    const oldReading = new Date(NOW - 7 * 60 * 60_000).toISOString();
    state.providers = [
      provider("claudeAgent", { checkedAt: oldReading, windows: CLAUDE_WINDOWS }),
      provider("codex", { checkedAt: oldReading, windows: CODEX_WINDOWS }),
    ];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    // The strip's own first read is in flight (the reading is past a minute).
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await openSheet();

    const during = visibleText();
    expect(during).toContain("26% used");
    expect(during).toContain("8% used");
    expect(during).toContain("Updated");
    expect(during).toContain("Refreshing");
    expect(during).not.toContain("Checking");

    await act(async () => {
      for (const finish of finishers) finish();
    });
    await settle();
    const after = visibleText();
    expect(after).not.toContain("Refreshing");
    expect(after).toContain("26% used");
  });

  it("shows the last values plus Couldn't refresh and its age after a failed probe", async () => {
    const reading = new Date(NOW - 3 * 60 * 60_000).toISOString();
    state.providers = [
      provider("claudeAgent", {
        checkedAt: reading,
        windows: CLAUDE_WINDOWS,
        refreshFailed: { at: new Date(NOW).toISOString(), message: "CLI timed out" },
      }),
      provider("codex", { checkedAt: new Date(NOW).toISOString(), windows: CODEX_WINDOWS }),
    ];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    await openSheet();
    // Let the probes the strip and the sheet asked for settle.
    await settle();

    const text = visibleText();
    expect(text).toContain("26% used");
    expect(text).toContain("Updated 3h");
    expect(text).toContain("Couldn't refresh · CLI timed out");
    expect(text).not.toContain("Checking");
    // Codex read fine: no failure line for it.
    expect(text.split("Couldn't refresh").length - 1).toBe(1);
    // The strip still carries the numbers too.
    expect(renderer!.root.findAllByType("button")[0]!.props["aria-label"]).toContain(
      "Claude, Session 26 percent used, Weekly 8 percent used",
    );
  });

  it("gives a reason, not a bare placeholder, for a provider that has never been read", async () => {
    state.providers = [
      { ...provider("claudeAgent", undefined), auth: { status: "unauthenticated" } },
      provider("codex", { checkedAt: new Date(NOW).toISOString(), windows: CODEX_WINDOWS }),
    ] as ServerProvider[];
    await act(async () => {
      renderer = create(<PersonalUsageStrip now={NOW} />);
    });
    await openSheet();
    await settle();
    const text = visibleText();
    expect(text).toContain("Not signed in to Claude");
    expect(text).not.toContain("Checking");
  });
});
