import type { ReactNode } from "react";

import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PersonalUsageStrip } from "./PersonalUsageStrip";

const NOW = Date.parse("2026-09-13T12:00:00Z");

const state = vi.hoisted(() => ({ providers: [] as unknown[] }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("~/state/server", () => ({
  primaryServerProvidersAtom: {},
  serverEnvironment: { refreshProviders: { label: "refreshProviders" } },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
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
    expect(
      renderer!.root.findAll(
        (node) => node.type === "button" && node.props["aria-label"] === "Refresh usage",
      ),
    ).toHaveLength(1);
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
});
