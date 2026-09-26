import type { ReactNode } from "react";

import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PersonalUsageStrip } from "./PersonalUsageStrip";

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

function provider(driver: string, usageLimits: unknown): ServerProvider {
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
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(driver),
  } as unknown as ServerProvider;
}

const CLAUDE = provider("claudeAgent", {
  checkedAt: "2026-09-13T11:59:00Z",
  windows: [
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
  ],
});

const CODEX = provider("codex", {
  checkedAt: "2026-09-13T11:58:00Z",
  windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 12 }],
});

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
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
