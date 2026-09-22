import type { JSX } from "react";
import { useState } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { Cpu } from "lucide-react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import {
  type ProviderRowAction,
  type ProviderUpdateRow,
  withPendingAction,
} from "./providerUpdateRows";
import { personalProviderRecheck } from "./usePersonalBots";

const ROW_BUTTON =
  "h-11 shrink-0 rounded-[var(--personal-radius-button)] text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

/**
 * Settings > Providers rows. Update runs the existing provider update command;
 * its queued/running/failed state and the post-update test arrive on the
 * provider snapshot, so the row re-renders from real state.
 */
export function PersonalProviderRows({
  environmentId,
  rows,
}: {
  environmentId: EnvironmentId;
  rows: ReadonlyArray<ProviderUpdateRow>;
}): JSX.Element {
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const recheck = useAtomCommand(personalProviderRecheck, { reportFailure: false });
  // Requests in flight (the snapshot takes over once the server answers).
  const [sending, setSending] = useState<ReadonlyMap<string, ProviderRowAction>>(() => new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());

  const send = async (
    instanceId: string,
    action: ProviderRowAction,
    request: () => ReturnType<typeof recheck> | ReturnType<typeof updateProvider>,
    fallback: string,
  ) => {
    if (sending.has(instanceId)) return;
    setSending((previous) => new Map(previous).set(instanceId, action));
    const result = await request();
    const failure = commandFailureMessage(result, fallback);
    setErrors((previous) => {
      const next = new Map(previous);
      if (failure === null) next.delete(instanceId);
      else next.set(instanceId, failure);
      return next;
    });
    setSending((previous) => {
      const next = new Map(previous);
      next.delete(instanceId);
      return next;
    });
  };

  return (
    <>
      {rows.map((snapshotRow) => {
        const pending = sending.get(snapshotRow.instanceId) ?? null;
        const inFlight = pending !== null;
        // Status and detail answer the tap at once; the buttons keep their
        // place (disabled) so the row does not jump while the request runs.
        const row = withPendingAction(snapshotRow, pending);
        const error = errors.get(row.instanceId) ?? null;
        const driver = row.driver;
        return (
          <li key={row.instanceId} className="flex min-h-14 flex-col gap-1 px-4 py-2.5">
            <div className="flex items-center gap-3">
              <Cpu
                aria-hidden="true"
                className="size-5 shrink-0 text-[var(--personal-text)]"
                strokeWidth={1.75}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-semibold text-[var(--personal-text)]">
                  {row.label}
                </span>
                <span className="text-[13px] text-[var(--personal-text-secondary)]">
                  {row.version}
                  {row.status !== null ? (
                    <>
                      {" · "}
                      <span
                        className={
                          row.status.tone === "review"
                            ? "font-medium text-[var(--personal-review-text)]"
                            : undefined
                        }
                      >
                        {row.status.text}
                      </span>
                    </>
                  ) : null}
                </span>
              </span>
              {snapshotRow.canUpdate && driver !== null ? (
                <button
                  type="button"
                  disabled={inFlight}
                  aria-busy={pending === "update"}
                  onClick={() =>
                    void send(
                      row.instanceId,
                      "update",
                      () =>
                        updateProvider({
                          environmentId,
                          input: { provider: driver, instanceId: row.instanceId },
                        }),
                      `Couldn't start the ${row.label} update.`,
                    )
                  }
                  className={`${ROW_BUTTON} bg-[var(--personal-primary)] px-4 text-[var(--personal-primary-text)]`}
                >
                  Update
                </button>
              ) : null}
              {snapshotRow.canCheck ? (
                <button
                  type="button"
                  disabled={inFlight}
                  aria-busy={pending === "check"}
                  aria-label={`Check ${row.label} again`}
                  onClick={() =>
                    void send(
                      row.instanceId,
                      "check",
                      () => recheck({ environmentId, input: { instanceId: row.instanceId } }),
                      `Couldn't check ${row.label}.`,
                    )
                  }
                  className={`${ROW_BUTTON} px-3 text-[var(--personal-primary)]`}
                >
                  {pending === "check" ? "Checking…" : "Check again"}
                </button>
              ) : null}
            </div>
            {row.detail !== null ? (
              <p className="pl-8 text-[13px] break-words text-[var(--personal-text-secondary)]">
                {row.detail}
              </p>
            ) : null}
            {error !== null ? (
              <p role="alert" className="pl-8 text-sm text-[var(--personal-error)]">
                {error}
              </p>
            ) : null}
          </li>
        );
      })}
    </>
  );
}
