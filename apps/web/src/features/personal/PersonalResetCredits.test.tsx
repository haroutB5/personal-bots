import { createContext, useContext, type ReactElement, type ReactNode } from "react";

import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import PersonalResetCredits from "./PersonalResetCredits";
import type { UsageCardResetCredits } from "./usagePresentation";

const NOW = Date.parse("2026-09-13T12:00:00Z");
const ENV = "env-1" as EnvironmentId;

const state = vi.hoisted(() => ({
  consume: vi.fn(),
}));

// Never the real RPC: a redeem spends one of the owner's banked resets.
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => state.consume,
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { consumeResetCredit: { label: "consumeResetCredit" } },
}));

const DialogContext = createContext<(open: boolean) => void>(() => {});
vi.mock("~/components/ui/alert-dialog", () => ({
  AlertDialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) =>
    open ? (
      <DialogContext.Provider value={onOpenChange}>
        <div data-slot="alert-dialog">{children}</div>
      </DialogContext.Provider>
    ) : null,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogClose: ({ children }: { children: ReactNode; render?: ReactElement }) => {
    const onOpenChange = useContext(DialogContext);
    return (
      <button type="button" data-close onClick={() => onOpenChange(false)}>
        {children}
      </button>
    );
  },
}));

function credits(availableCount: number, nextExpiresAt?: string): UsageCardResetCredits {
  return {
    credits: { availableCount, ...(nextExpiresAt ? { nextExpiresAt } : {}) },
    input: { instanceId: "claudeAgent" as ProviderInstanceId },
  } as UsageCardResetCredits;
}

let renderer: ReactTestRenderer | undefined;
let onRedeemed: ReturnType<typeof vi.fn<() => void>>;

async function mount(resetCredits: UsageCardResetCredits) {
  await act(async () => {
    renderer = create(
      <PersonalResetCredits
        environmentId={ENV}
        title="Claude"
        resetCredits={resetCredits}
        now={NOW}
        onRedeemed={onRedeemed}
      />,
    );
  });
}

function text(): string {
  return JSON.stringify(renderer!.toJSON());
}

function buttonLabelled(label: string): ReactTestInstance {
  const matches = renderer!.root.findAll(
    (node) =>
      node.type === "button" &&
      (node.props["aria-label"] === label ||
        (typeof node.props.children === "string" && node.props.children === label)),
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function redeemButton(): ReactTestInstance {
  return buttonLabelled("Redeem a banked Claude reset");
}

function confirmButton(): ReactTestInstance {
  const dialog = renderer!.root.find((node) => node.props["data-slot"] === "alert-dialog");
  return dialog.find((node) => node.type === "button" && node.props.children === "Redeem");
}

async function openConfirm() {
  await act(async () => redeemButton().props.onClick());
}

beforeEach(() => {
  state.consume = vi.fn();
  onRedeemed = vi.fn<() => void>();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

describe("PersonalResetCredits", () => {
  it("renders nothing with no banked credits", async () => {
    await mount(credits(0));
    expect(renderer!.toJSON()).toBeNull();
  });

  it("pluralises the count and drops the expiry line when none is reported", async () => {
    await mount(credits(2));
    expect(text()).toContain("2 resets banked");
    expect(text()).not.toContain("Next expires");
  });

  it("shows the banked count, the next expiry and a Redeem button", async () => {
    await mount(credits(1, "2026-09-20T12:00:00Z"));
    expect(text()).toContain("1 reset banked");
    expect(text()).toContain("Next expires in ");
    // The duration is one no-wrap unit, so "7d" and "0h" never split.
    const duration = renderer!.root.find(
      (node) => node.type === "span" && node.props.className === "whitespace-nowrap",
    );
    expect(duration.props.children).toBe("7d 0h");
    expect(redeemButton().props.disabled).toBe(false);
    expect(
      renderer!.root.findAll((node) => node.props["data-slot"] === "alert-dialog"),
    ).toHaveLength(0);
  });

  it("asks before redeeming, and Cancel spends nothing", async () => {
    await mount(credits(2));
    await openConfirm();
    expect(text()).toContain("Redeem a banked Claude reset?");
    expect(text()).toContain("clears the current Claude limit windows now");

    const cancel = renderer!.root.find((node) => node.props["data-close"] === true);
    await act(async () => cancel.props.onClick());

    expect(
      renderer!.root.findAll((node) => node.props["data-slot"] === "alert-dialog"),
    ).toHaveLength(0);
    expect(state.consume).not.toHaveBeenCalled();
    expect(onRedeemed).not.toHaveBeenCalled();
  });

  it("confirming calls consume once, disables while in flight, then refreshes", async () => {
    let settle: (value: unknown) => void = () => {};
    state.consume.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    await mount(credits(1));
    await openConfirm();

    const confirm = confirmButton();
    await act(async () => {
      void confirm.props.onClick();
      // A second tap in the same frame must not spend a second credit.
      void confirm.props.onClick();
    });

    expect(state.consume).toHaveBeenCalledTimes(1);
    expect(state.consume).toHaveBeenCalledWith({
      environmentId: ENV,
      input: { instanceId: "claudeAgent" },
    });
    expect(redeemButton().props.disabled).toBe(true);
    expect(text()).toContain("Redeeming…");
    expect(onRedeemed).not.toHaveBeenCalled();

    await act(async () => settle({ _tag: "Success", value: { outcome: "reset" } }));

    expect(text()).toContain("Reset applied. Your windows have cleared.");
    expect(onRedeemed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["reset", "Reset applied. Your windows have cleared."],
    ["nothingToReset", "Nothing to reset right now."],
    ["noCredit", "No reset credit left."],
    ["alreadyRedeemed", "That credit was already redeemed."],
  ])("says what happened for %s", async (outcome, message) => {
    state.consume.mockResolvedValue({ _tag: "Success", value: { outcome } });
    await mount(credits(1));
    await openConfirm();
    await act(async () => confirmButton().props.onClick());
    expect(text()).toContain(message);
    expect(onRedeemed).toHaveBeenCalledTimes(1);
  });

  it("prefers the server's warning when the redeem half-succeeded", async () => {
    state.consume.mockResolvedValue({
      _tag: "Success",
      value: { outcome: "reset", warning: "Reset applied, but the hub cooldown did not clear." },
    });
    await mount(credits(1));
    await openConfirm();
    await act(async () => confirmButton().props.onClick());
    expect(text()).toContain("Reset applied, but the hub cooldown did not clear.");
  });

  it("shows a failure as text and keeps working", async () => {
    state.consume.mockResolvedValue({
      _tag: "Failure",
      cause: { error: new Error("401 Incorrect API key provided") },
    });
    await mount(credits(1));
    await openConfirm();
    await act(async () => confirmButton().props.onClick());
    expect(text()).toContain("401 Incorrect API key provided");
    expect(redeemButton().props.disabled).toBe(false);
    expect(onRedeemed).toHaveBeenCalledTimes(1);
  });

  it("falls back to a plain sentence for an opaque failure", async () => {
    state.consume.mockResolvedValue({ _tag: "Failure", cause: { reasons: [] } });
    await mount(credits(1));
    await openConfirm();
    await act(async () => confirmButton().props.onClick());
    expect(text()).toContain("Could not use the reset credit.");
  });

  it("keeps the outcome on screen after the last credit is spent", async () => {
    state.consume.mockResolvedValue({ _tag: "Success", value: { outcome: "reset" } });
    await mount(credits(1));
    await openConfirm();
    await act(async () => confirmButton().props.onClick());
    await act(async () =>
      renderer!.update(
        <PersonalResetCredits
          environmentId={ENV}
          title="Claude"
          resetCredits={credits(0)}
          now={NOW}
          onRedeemed={onRedeemed}
        />,
      ),
    );
    expect(text()).toContain("Reset applied. Your windows have cleared.");
    expect(
      renderer!.root.findAll((node) => node.props["aria-label"] === "Redeem a banked Claude reset"),
    ).toHaveLength(0);
  });
});
