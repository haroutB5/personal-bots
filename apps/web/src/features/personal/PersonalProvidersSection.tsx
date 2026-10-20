import type { JSX } from "react";
import { useMemo, useState } from "react";

import type {
  EnvironmentId,
  PersonalBot,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import {
  buildProviderList,
  withPendingAction,
  type ProviderRow,
  type ProviderRowAction,
  type ProviderRowPending,
} from "./providerRows";
import { useProviderInstallStates } from "./providers/providerInstallStates";
import {
  BUTTON_OUTLINE,
  BUTTON_PRIMARY,
  CARD,
  FOCUS,
  ProgressBar,
  ProviderTile,
  SECTION_TITLE,
  StatusDot,
} from "./providers/providerUi";
import { personalProviderRecheck } from "./usePersonalBots";

const ROW_BUTTON_CLASS = "min-w-[78px] px-3.5 text-[14px] font-semibold";

/** What a row's action does when it is more than "go to the page". */
function pendingFor(row: ProviderRow, action: ProviderRowAction): ProviderRowPending {
  switch (action.kind) {
    case "update":
      return { kind: "update" };
    case "goBack":
      return { kind: "goBack", version: null };
    case "install":
      return { kind: "install" };
    case "signIn":
      return { kind: "signIn" };
    case "testAgain":
    case "tryAgain":
    case "fix":
      return row.state === "installFailed" ? { kind: "install" } : { kind: "check" };
  }
}

/**
 * Settings > Providers (provider-setup SPEC section 3): a card of provider
 * rows, each with one status and at most one action, a Check all in the header
 * and Add provider as the last row. The whole row opens the provider's page;
 * an action runs the existing server command, or opens the page where the
 * action needs a decision (Install asks first, Sign in, Fix).
 */
export function PersonalProvidersSection({
  environmentId,
  providers,
  bots,
}: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  bots: ReadonlyArray<PersonalBot>;
}): JSX.Element {
  const navigate = useNavigate();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, {
    reportFailure: false,
    reportDefect: false,
  });
  const recheck = useAtomCommand(personalProviderRecheck, { reportFailure: false });
  const runTest = useAtomCommand(serverEnvironment.runProviderTest, {
    reportFailure: false,
    reportDefect: false,
  });
  const { installs, watchers } = useProviderInstallStates(environmentId, providers);
  const list = useMemo(
    () => buildProviderList(providers, bots, installs),
    // `now` only matters for the usage-limit retry time, which the snapshot already moves.
    [providers, bots, installs],
  );

  // Requests in flight (the snapshot takes over once the server answers).
  const [sending, setSending] = useState<ReadonlyMap<string, ProviderRowPending>>(() => new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [checkingAll, setCheckingAll] = useState(false);

  const setPending = (instanceId: string, pending: ProviderRowPending | null) =>
    setSending((previous) => {
      const next = new Map(previous);
      if (pending === null) next.delete(instanceId);
      else next.set(instanceId, pending);
      return next;
    });
  const setError = (instanceId: string, failure: string | null) =>
    setErrors((previous) => {
      const next = new Map(previous);
      if (failure === null) next.delete(instanceId);
      else next.set(instanceId, failure);
      return next;
    });

  const send = async (
    instanceId: string,
    pending: ProviderRowPending,
    request: () => Promise<Parameters<typeof commandFailureMessage>[0]>,
    fallback: string,
  ) => {
    if (sending.has(instanceId)) return;
    setPending(instanceId, pending);
    const result = await request();
    setError(instanceId, commandFailureMessage(result, fallback));
    setPending(instanceId, null);
  };

  const openPage = (
    instanceId: string,
    action?: "install" | "signIn" | "fix",
  ): Promise<void> | void =>
    navigate({
      to: "/bots/settings/providers/$instanceId",
      params: { instanceId },
      ...(action === undefined ? {} : { search: { action } }),
    });

  const runAction = (row: ProviderRow, action: ProviderRowAction) => {
    const instanceId = row.instanceId;
    const driver: ProviderDriverKind | null = row.driver;
    const id = instanceId as ProviderInstanceId;
    switch (action.kind) {
      case "install":
        // Every install asks first: the page opens its confirmation.
        void openPage(instanceId, "install");
        return;
      case "signIn":
        void openPage(instanceId, "signIn");
        return;
      case "fix":
        void openPage(instanceId, "fix");
        return;
      case "update":
        if (driver === null) return;
        void send(
          instanceId,
          pendingFor(row, action),
          () => updateProvider({ environmentId, input: { provider: driver, instanceId: id } }),
          `Couldn't start the ${row.label} update.`,
        );
        return;
      case "goBack": {
        if (driver === null) return;
        const previous = providers.find((candidate) => candidate.instanceId === instanceId)
          ?.smokeCheck?.previousVersion;
        if (previous === undefined) return;
        void send(
          instanceId,
          { kind: "goBack", version: previous },
          () =>
            updateProvider({
              environmentId,
              input: { provider: driver, instanceId: id, targetVersion: previous, rollback: true },
            }),
          `Couldn't go back to ${previous}.`,
        );
        return;
      }
      case "tryAgain":
        if (row.state === "installFailed") {
          void send(
            instanceId,
            { kind: "install" },
            () => startInstall({ environmentId, input: { instanceId: id } }),
            `Couldn't start the ${row.label} install.`,
          );
        } else if (row.state === "updateFailed" && driver !== null) {
          void send(
            instanceId,
            { kind: "update" },
            () => updateProvider({ environmentId, input: { provider: driver, instanceId: id } }),
            `Couldn't start the ${row.label} update.`,
          );
        } else {
          void send(
            instanceId,
            { kind: "check" },
            () => recheck({ environmentId, input: { instanceId: id } }),
            `Couldn't check ${row.label}.`,
          );
        }
        return;
      case "testAgain":
        void send(
          instanceId,
          row.state === "testFailed" ? { kind: "test" } : { kind: "check" },
          () =>
            row.state === "testFailed"
              ? runTest({ environmentId, input: { instanceId: id } })
              : recheck({ environmentId, input: { instanceId: id } }),
          `Couldn't test ${row.label}.`,
        );
        return;
    }
  };

  const checkAll = async () => {
    if (checkingAll) return;
    setCheckingAll(true);
    const targets = list.rows.filter(
      (row) => row.driver !== null && !row.busy && !sending.has(row.instanceId),
    );
    for (const row of targets) setPending(row.instanceId, { kind: "check" });
    await Promise.all(
      targets.map(async (row) => {
        const result = await recheck({
          environmentId,
          input: { instanceId: row.instanceId as ProviderInstanceId },
        });
        setError(row.instanceId, commandFailureMessage(result, `Couldn't check ${row.label}.`));
        setPending(row.instanceId, null);
      }),
    );
    setCheckingAll(false);
  };

  return (
    <section aria-labelledby="settings-providers">
      {watchers}
      <div className="mb-2 flex h-11 items-center justify-between">
        <h2 id="settings-providers" className={`${SECTION_TITLE} mb-0`}>
          Providers
        </h2>
        <button
          type="button"
          onClick={() => void checkAll()}
          disabled={checkingAll || list.rows.length === 0}
          aria-busy={checkingAll}
          className={`-mr-2.5 flex h-11 items-center px-2.5 text-[15px] font-semibold text-[var(--personal-text-secondary)] ${FOCUS} disabled:opacity-60`}
        >
          {checkingAll ? "Checking…" : "Check all"}
        </button>
      </div>
      <ul className={`${CARD} divide-y divide-[var(--personal-border)]`}>
        {list.rows.map((snapshotRow) => {
          const pending = sending.get(snapshotRow.instanceId) ?? null;
          const row = withPendingAction(snapshotRow, pending);
          return (
            <ProviderListRow
              key={row.instanceId}
              row={row}
              error={errors.get(row.instanceId) ?? null}
              onAction={(action) => runAction(snapshotRow, action)}
            />
          );
        })}
        <li>
          <Link
            to="/bots/settings/providers/add"
            className="flex min-h-16 items-center gap-3 px-3.5 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
          >
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-[var(--personal-border-strong)] text-[var(--personal-text)]"
            >
              <Plus className="size-5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1 text-[15px] font-semibold text-[var(--personal-text)]">
              Add provider
            </span>
            <ChevronRight
              aria-hidden="true"
              className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
              strokeWidth={1.75}
            />
          </Link>
        </li>
      </ul>
      <p className="mt-2 px-1 text-[13px] text-[var(--personal-text-secondary)]">
        After an update, each bot switches to the new version once its current reply ends.
      </p>
    </section>
  );
}

function statusClass(row: ProviderRow): string {
  return row.tone === "review"
    ? "font-medium text-[var(--personal-review-text)]"
    : row.tone === "error"
      ? "font-medium text-[var(--personal-error)]"
      : "text-[var(--personal-text-secondary)]";
}

function ProviderListRow({
  row,
  error,
  onAction,
}: {
  row: ProviderRow;
  error: string | null;
  onAction: (action: ProviderRowAction) => void;
}): JSX.Element {
  const action = row.action;
  const body = (
    <>
      <ProviderTile driver={row.driver} label={row.label} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
          {row.label}
        </span>
        <span className="flex items-center gap-2 text-[13px] leading-[18px]">
          <StatusDot dot={row.dot} />
          <span className={`min-w-0 truncate ${statusClass(row)}`}>{row.statusText}</span>
        </span>
      </span>
    </>
  );
  return (
    <li
      className="px-3.5 py-2.5"
      data-provider-row={row.instanceId}
      data-provider-state={row.state}
    >
      <div className="flex min-h-11 items-center gap-3">
        {row.driver === null ? (
          <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
        ) : (
          <Link
            to="/bots/settings/providers/$instanceId"
            params={{ instanceId: row.instanceId }}
            aria-label={`${row.label}, ${row.statusText}`}
            className={`-my-1 flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-[10px] ${FOCUS}`}
          >
            {body}
          </Link>
        )}
        {action !== null ? (
          <button
            type="button"
            onClick={() => onAction(action)}
            className={`${action.kind === "update" ? BUTTON_PRIMARY : BUTTON_OUTLINE} ${ROW_BUTTON_CLASS}`}
          >
            {action.label}
          </button>
        ) : row.driver !== null ? (
          <ChevronRight
            aria-hidden="true"
            className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
            strokeWidth={1.75}
          />
        ) : null}
      </div>
      {row.progress !== null ? (
        <div className="mt-1 pl-12">
          <ProgressBar
            fraction={row.progress.fraction}
            label={`${row.label} ${row.state === "updating" ? "update" : "install"}`}
            valueText={row.statusText}
          />
        </div>
      ) : null}
      {row.detail !== null ? (
        <p className="mt-1 line-clamp-2 pl-12 text-[13px] leading-[18px] break-words text-[var(--personal-text-secondary)]">
          {row.detail}
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="mt-1 pl-12 text-sm text-[var(--personal-error)]">
          {error}
        </p>
      ) : null}
    </li>
  );
}
