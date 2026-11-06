import type { JSX } from "react";
import { useState } from "react";

import type { AuthSessionId } from "@t3tools/contracts";

import { Link } from "@tanstack/react-router";
import { ChevronLeft, Smartphone } from "lucide-react";

import { deviceRows } from "@hbots/personal-client/settings/devices";
import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { usePersonalEnvironmentId } from "./usePersonalBots";
import { usePersonalDevices, personalDeviceRevoke } from "./usePersonalDevices";
import { useMinuteNow } from "./useMinuteNow";

const CARD =
  "overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]";

export function DevicesScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const query = usePersonalDevices(environmentId);
  const revoke = useAtomCommand(personalDeviceRevoke, { reportFailure: false });
  const now = useMinuteNow();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const devices = query.data?.devices ?? null;
  const rows = devices === null ? [] : deviceRows(devices, now);

  const revokeDevice = async (sessionId: string, label: string) => {
    if (environmentId === null || busyId !== null) return;
    const confirmed = await requestConfirmDialog(
      `Revoke ${label}? That device signs out at once.`,
      {
        variant: "destructive",
        confirmLabel: "Revoke",
      },
    );
    if (confirmed !== true) return;
    setBusyId(sessionId);
    setError(null);
    const result = await revoke({
      environmentId,
      input: { sessionId: sessionId as AuthSessionId },
    });
    const failure =
      result === null
        ? "Not connected to your computer."
        : commandFailureMessage(result, "Could not revoke that device. Try again.");
    setError(failure);
    setBusyId(null);
  };

  return (
    <div className="flex flex-col gap-5 px-4 pb-24 pt-2">
      <header className="flex h-14 items-center gap-1">
        <Link
          to="/bots/settings"
          activeOptions={{ exact: true }}
          aria-label="Back to Settings"
          className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        <h1 className="min-w-0 flex-1 text-[19px] font-bold text-[var(--personal-text)]">
          Devices
        </h1>
      </header>

      <p className="text-[14px] leading-relaxed text-[var(--personal-text-secondary)]">
        Everything signed in to hbots. Revoke a device to remove its session at once.
      </p>

      {error === null ? null : (
        <p role="alert" className="text-[14px] text-[var(--personal-error)]">
          {error}
        </p>
      )}

      <ul className={`${CARD} divide-y divide-[var(--personal-border)]`}>
        {devices === null ? (
          <li className="px-4 py-6 text-[14px] text-[var(--personal-text-secondary)]">Loading…</li>
        ) : rows.length === 0 ? (
          <li className="px-4 py-6 text-[14px] text-[var(--personal-text-secondary)]">
            No other devices are signed in.
          </li>
        ) : (
          rows.map((row) => (
            <li key={row.sessionId} className="flex min-h-16 items-center gap-3 px-4 py-3">
              <Smartphone
                aria-hidden="true"
                className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
                strokeWidth={1.75}
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-semibold text-[var(--personal-text)]">
                  {row.title}
                </span>
                <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
                  {row.detail}
                </span>
              </div>
              {row.canRevoke ? (
                <button
                  type="button"
                  disabled={busyId === row.sessionId}
                  onClick={() => void revokeDevice(row.sessionId, row.title)}
                  className="min-h-11 shrink-0 rounded-full border border-[var(--personal-border-strong)] px-3 text-[13px] font-semibold text-[var(--personal-error)] disabled:opacity-60"
                >
                  {busyId === row.sessionId ? "Revoking…" : "Revoke"}
                </button>
              ) : (
                <span className="shrink-0 rounded-full bg-[var(--personal-fill-muted)] px-2.5 py-1 text-[12px] font-medium text-[var(--personal-text-secondary)]">
                  This device
                </span>
              )}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
