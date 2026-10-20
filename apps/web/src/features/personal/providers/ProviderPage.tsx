import type { JSX, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PersonalBot,
  ProviderAuthState,
  ProviderInstallState,
  ProviderInstanceEnvironmentVariable,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight, Laptop, Trash2 } from "lucide-react";

import { providerApiKeyField } from "~/components/settings/providerApiKeys";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerProvidersAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "../commandFeedback";
import {
  botsNamed,
  botsUseText,
  botsUsingModels,
  botsUsingProvider,
  currentSmoke,
  isInstallActive,
  providerNeedsSignIn,
  providerReportsUsage,
  providerRow,
  withPendingAction,
  type ProviderRow,
  type ProviderRowPending,
} from "../providerRows";
import { resolveBotProvider } from "../botSummaries";
import {
  personalBotUpdate,
  personalProfileSet,
  personalProviderRecheck,
  useHiddenUsageProviders,
  usePersonalBotsList,
  usePersonalEnvironmentId,
} from "../usePersonalBots";
import {
  answeredLine,
  pageNote,
  setupFinished,
  setupSteps,
  stateWord,
  testLine,
  type NoteButton,
  type SetupStep,
} from "./providerPageModel";
import { downloadLine, licenceLine, providerFacts, publisherLine } from "./providerFacts";
import { catalogInstallFailureNote } from "./catalogModel";
import {
  BUTTON_BIG,
  BUTTON_OUTLINE,
  BUTTON_PRIMARY,
  BUTTON_QUIET,
  CARD,
  CardRow,
  ProgressBar,
  ProviderNote,
  ProviderSwitch,
  ProviderTile,
  SECTION_TITLE,
  StatusDot,
} from "./providerUi";
import { ProviderKeyEntry } from "./ProviderKeyEntry";
import { ConfirmSheet, InstallConfirmSheet, RemapSheet } from "./ProviderSheets";
import { SignInRedirect } from "./SignInRedirect";
import { useProviderInstanceSettings } from "./useProviderInstanceSettings";

export type ProviderPageAction = "install" | "signIn" | "fix";

type SheetName = "install" | "remove" | "turnOff" | "signOut" | "remap";

/** What "sign in" means on this provider, which decides the step 2 screen. */
type SignInKind = "redirect" | "key" | "laptop";

function signInKindOf(snapshot: ServerProvider): SignInKind {
  if (snapshot.setup?.canAuthenticate === true) return "redirect";
  if (providerApiKeyField(snapshot.driver) !== undefined) return "key";
  return "laptop";
}

/** Where a provider that signs in on the laptop says to do it. */
const LAPTOP_SIGN_IN: Readonly<Record<string, string>> = {
  claudeAgent:
    "Open a terminal on your laptop and run claude, then sign in with your Claude account.",
  codex: "Open a terminal on your laptop and run codex login.",
  cursor: "Open a terminal on your laptop and run cursor-agent login.",
  opencode: "Open a terminal on your laptop and run opencode auth login.",
  grok: "Open a terminal on your laptop and run grok login, or add an API key below.",
};

function timeAgo(iso: string | null | undefined, nowMs: number): string | null {
  if (iso === null || iso === undefined) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function PageHeader({ title, visible }: { title: string; visible: boolean }): JSX.Element {
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-1 bg-[var(--personal-bg)]">
      <Link
        to="/bots/settings"
        activeOptions={{ exact: true }}
        aria-label="Back to Settings"
        className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      >
        <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
      </Link>
      <h1
        className={`min-w-0 flex-1 truncate text-[19px] font-bold text-[var(--personal-text)] ${visible ? "" : "sr-only"}`}
      >
        {title}
      </h1>
    </header>
  );
}

export function ProviderPageScreen({
  instanceId,
  action,
  returnTarget,
}: {
  readonly instanceId: string;
  readonly action?: ProviderPageAction | undefined;
  readonly returnTarget?: string | undefined;
}): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const list = usePersonalBotsList(environmentId);
  const snapshot = providers.find((candidate) => candidate.instanceId === instanceId);
  const bots = useMemo(() => list.data?.bots ?? [], [list.data]);

  if (environmentId === null || snapshot === undefined) {
    return (
      <div className="flex flex-col px-5 pb-8">
        <PageHeader title="Provider" visible />
        <p className="text-[15px] text-[var(--personal-text-secondary)]">
          {environmentId === null
            ? "Connecting to your laptop…"
            : "This provider isn't set up on your computer."}
        </p>
      </div>
    );
  }
  return (
    <ProviderPageBody
      key={snapshot.instanceId}
      environmentId={environmentId}
      snapshot={snapshot}
      providers={providers}
      bots={bots}
      action={action}
      returnTarget={returnTarget}
    />
  );
}

function ProviderPageBody({
  environmentId,
  snapshot,
  providers,
  bots,
  action,
  returnTarget,
}: {
  environmentId: EnvironmentId;
  snapshot: ServerProvider;
  providers: ReadonlyArray<ServerProvider>;
  bots: ReadonlyArray<PersonalBot>;
  action: ProviderPageAction | undefined;
  returnTarget?: string | undefined;
}): JSX.Element {
  const navigate = useNavigate();
  const instanceId = snapshot.instanceId as ProviderInstanceId;
  const driver = snapshot.driver;
  const setup = snapshot.setup;
  const label = resolveBotProvider(instanceId, providers).label;
  const facts = providerFacts(driver);
  const kind = signInKindOf(snapshot);
  const commandOptions = { reportFailure: false, reportDefect: false };

  const installQuery = useEnvironmentQuery(
    serverEnvironment.providerInstallState({ environmentId, input: { instanceId } }),
  );
  const authQuery = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  );
  const install = setup?.canInstall === true ? installQuery.data : null;
  const auth = setup?.canAuthenticate === true ? authQuery.data : null;

  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, commandOptions);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, commandOptions);
  const removeInstall = useAtomCommand(
    serverEnvironment.removeProviderInstallation,
    commandOptions,
  );
  const logoutAuth = useAtomCommand(serverEnvironment.logoutProviderAuth, commandOptions);
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, commandOptions);
  const runTest = useAtomCommand(serverEnvironment.runProviderTest, commandOptions);
  const recheck = useAtomCommand(personalProviderRecheck, commandOptions);
  const updateBot = useAtomCommand(personalBotUpdate, commandOptions);
  const setProfile = useAtomCommand(personalProfileSet, commandOptions);
  const hiddenUsage = useHiddenUsageProviders(environmentId);
  const instanceSettings = useProviderInstanceSettings(environmentId, instanceId, driver);

  const [sheet, setSheet] = useState<SheetName | null>(
    action === "install" && !snapshot.installed ? "install" : null,
  );
  const [pending, setPending] = useState<ProviderRowPending | null>(null);
  const [startingInstall, setStartingInstall] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [usagePending, setUsagePending] = useState<boolean | null>(null);
  const [enabledPending, setEnabledPending] = useState<boolean | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const [editingServer, setEditingServer] = useState(false);
  const [addingKey, setAddingKey] = useState(false);
  const [nowMs] = useState(() => Date.now());
  const heroRef = useRef<HTMLDivElement>(null);
  const [heroVisible, setHeroVisible] = useState(true);

  useEffect(() => {
    const node = heroRef.current;
    if (node === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) =>
      setHeroVisible(entry?.isIntersecting ?? true),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const installActive = isInstallActive(install);
  const installed = snapshot.installed || (install?.installedVersion ?? null) !== null;
  const smoke = currentSmoke(snapshot);
  const authNeeded = installed && providerNeedsSignIn(snapshot);
  const row: ProviderRow = withPendingAction(
    providerRow({ snapshot, label, bots, install: install ?? null, now: new Date() }),
    pending,
  );
  const canTest = setup?.canTest === true;
  const canRemove = (setup?.canRemove === true || driver === ("registry" as any)) && installed;
  const users = botsUsingProvider(instanceId, bots);

  // The setup card shows while a step is open, and for the rest of this visit
  // once setup was seen, so the page can say "ready" when the last step lands.
  const incomplete = !installed || installActive || startingInstall || authNeeded;
  const [setupSeen, setSetupSeen] = useState(incomplete);
  useEffect(() => {
    if (incomplete) setSetupSeen(true);
  }, [incomplete]);
  const steps = setupSteps({
    installed: installed && !startingInstall,
    installFailed: install?.phase === "failed",
    authNeeded,
    canTest,
    testPassed: smoke?.status === "passed" && smoke.manual === true,
    testFailed: smoke?.status === "failed" && smoke.manual === true,
    installedVersion: snapshot.version ?? install?.installedVersion ?? null,
    signInNote:
      kind === "redirect" ? "Google account" : kind === "key" ? "API key" : "On your laptop",
  });
  const finished = setupFinished(steps);
  const showSetup =
    !finished &&
    (incomplete || setupSeen) &&
    (installed || startingInstall || installActive || install?.phase === "failed");
  // Done when every step is done; a provider with a test message waits for its answer.
  const showReady = finished && setupSeen;
  const before = !installed && !installActive && !startingInstall && install?.phase !== "failed";

  // After the last sign-in step lands, the test runs by itself, once.
  const testStarted = useRef(false);
  useEffect(() => {
    if (!setupSeen || !canTest || !installed || authNeeded || !snapshot.enabled) return;
    if (smoke?.status === "passed" && smoke.manual === true) return;
    if (smoke?.status === "checking" || smoke?.status === "failed" || testStarted.current) return;
    testStarted.current = true;
    void runTest({ environmentId, input: { instanceId } });
  }, [
    setupSeen,
    canTest,
    installed,
    authNeeded,
    snapshot.enabled,
    smoke,
    runTest,
    environmentId,
    instanceId,
  ]);

  // "Fix" from the list opens the remap sheet once the provider is known.
  const fixOpened = useRef(false);
  useEffect(() => {
    if (action !== "fix" || fixOpened.current) return;
    if (row.state === "modelGone") {
      fixOpened.current = true;
      setSheet("remap");
    }
  }, [action, row.state]);

  const run = async (
    pendingState: ProviderRowPending | null,
    request: () => Promise<Parameters<typeof commandFailureMessage>[0]>,
    fallback: string,
  ): Promise<boolean> => {
    setError(null);
    if (pendingState !== null) setPending(pendingState);
    const result = await request();
    if (pendingState !== null) setPending(null);
    const failure = commandFailureMessage(result, fallback);
    if (failure !== null) setError(failure);
    return failure === null;
  };

  const confirmInstall = async () => {
    setSheetBusy(true);
    setSheetError(null);
    setStartingInstall(true);
    // A provider added from here is on for bots from the start; a disabled
    // driver is not probed, so it would never notice its own install.
    if (!snapshot.enabled) instanceSettings.setEnabled(true);
    const result = await startInstall({ environmentId, input: { instanceId } });
    setSheetBusy(false);
    const failure = commandFailureMessage(result, `Couldn't start the ${label} install.`);
    if (failure !== null) {
      setStartingInstall(false);
      setSheetError(failure);
      return;
    }
    setSheet(null);
  };
  // The stream takes over once it reports the first phase.
  useEffect(() => {
    if (startingInstall && (installActive || install?.phase === "failed" || snapshot.installed)) {
      setStartingInstall(false);
    }
  }, [startingInstall, installActive, install?.phase, snapshot.installed]);

  const tryInstallAgain = () =>
    void run(
      { kind: "install" },
      () => startInstall({ environmentId, input: { instanceId } }),
      `Couldn't start the ${label} install.`,
    );

  const cancelInstallNow = () => {
    const operationId = install?.operationId;
    if (operationId === null || operationId === undefined) return;
    void run(
      null,
      () => cancelInstall({ environmentId, input: { instanceId, operationId } }),
      "Couldn't cancel the install.",
    );
  };

  const toggleEnabled = (next: boolean) => {
    if (!next && users.length > 0) {
      setSheet("turnOff");
      return;
    }
    setEnabledPending(next);
    instanceSettings.setEnabled(next);
  };
  useEffect(() => {
    if (enabledPending !== null && snapshot.enabled === enabledPending) setEnabledPending(null);
  }, [enabledPending, snapshot.enabled]);

  const usageShown = usagePending ?? !hiddenUsage.has(instanceId);
  const toggleUsage = async (visible: boolean) => {
    if (usagePending !== null) return;
    setUsagePending(visible);
    const result = await setProfile({
      environmentId,
      input: { usageVisibility: { instanceId, visible } },
    });
    const failure = commandFailureMessage(result, `Couldn't save ${label}'s usage setting.`);
    if (failure !== null) setError(failure);
    setUsagePending(null);
  };

  const onTest = () =>
    void run(
      { kind: "test" },
      () => runTest({ environmentId, input: { instanceId } }),
      `Couldn't test ${label}.`,
    );
  const onCheckAgain = () =>
    void run(
      { kind: "check" },
      () => recheck({ environmentId, input: { instanceId } }),
      `Couldn't check ${label}.`,
    );
  const onUpdate = () =>
    void run(
      { kind: "update" },
      () => updateProvider({ environmentId, input: { provider: driver, instanceId } }),
      `Couldn't start the ${label} update.`,
    );
  const goBackVersion = snapshot.smokeCheck?.previousVersion;
  const onGoBack = () => {
    if (goBackVersion === undefined) return;
    void run(
      { kind: "goBack", version: goBackVersion },
      () =>
        updateProvider({
          environmentId,
          input: {
            provider: driver,
            instanceId,
            targetVersion: goBackVersion,
            rollback: true,
            toVersion: goBackVersion,
          } as any,
        }),
      `Couldn't go back to ${goBackVersion}.`,
    );
  };

  const confirmRemove = async () => {
    setSheetBusy(true);
    setSheetError(null);
    const result = await removeInstall({ environmentId, input: { instanceId } });
    setSheetBusy(false);
    const failure = commandFailureMessage(result, `Couldn't remove ${label}.`);
    if (failure !== null) {
      setSheetError(failure);
      return;
    }
    setSheet(null);
    void navigate({ to: "/bots/settings" });
  };
  const confirmTurnOff = () => {
    setEnabledPending(false);
    instanceSettings.setEnabled(false);
    setSheet(null);
  };
  const confirmSignOut = async () => {
    setSheetBusy(true);
    setSheetError(null);
    const result = await logoutAuth({ environmentId, input: { instanceId } });
    setSheetBusy(false);
    const failure = commandFailureMessage(result, `Couldn't sign out of ${label}.`);
    if (failure !== null) {
      setSheetError(failure);
      return;
    }
    setSheet(null);
  };

  const missingModels = snapshot.smokeCheck?.missingModels ?? [];
  const affectedBots = botsUsingModels(instanceId, missingModels, bots);
  const applyRemap = async (model: string) => {
    setSheetBusy(true);
    setSheetError(null);
    let failure: string | null = null;
    for (const bot of affectedBots) {
      const result = await updateBot({
        environmentId,
        input: { botId: bot.botId, modelSelection: { instanceId, model } },
      });
      failure = commandFailureMessage(result, `Couldn't change ${bot.name}'s model.`);
      if (failure !== null) break;
    }
    setSheetBusy(false);
    if (failure !== null) {
      setSheetError(failure);
      return;
    }
    setSheet(null);
    onCheckAgain();
  };

  const note = pageNote(row, snapshot, canRemove);
  const onNoteButton = (button: NoteButton) => {
    switch (button) {
      case "goBack":
        return onGoBack();
      case "testAgain":
        return row.state === "testFailed" ? onTest() : onCheckAgain();
      case "tryAgain":
        if (row.state === "installFailed") return tryInstallAgain();
        if (row.state === "updateFailed") return onUpdate();
        return onCheckAgain();
      case "pickModel":
        return setSheet("remap");
      case "removeIt":
        return setSheet("remove");
    }
  };
  const noteButtonLabel = (button: NoteButton): string => {
    switch (button) {
      case "goBack":
        return goBackVersion === undefined ? "Go back" : `Go back to ${goBackVersion}`;
      case "testAgain":
        return "Test again";
      case "tryAgain":
        return "Try again";
      case "pickModel":
        return "Pick a new model";
      case "removeIt":
        return "Remove it";
    }
  };

  const instanceConfig = instanceSettings.instance?.config as
    | { serverUrl?: unknown; serverPassword?: unknown }
    | undefined;
  const serverUrl = typeof instanceConfig?.serverUrl === "string" ? instanceConfig.serverUrl : "";
  const keyField = providerApiKeyField(driver);
  const environmentVariables = instanceSettings.instance?.environment ?? [];
  const enabledShown = enabledPending ?? snapshot.enabled;
  const publisher = publisherLine(facts);

  return (
    <div className="flex flex-col px-5 pb-10" data-provider-page={instanceId}>
      <PageHeader title={label} visible={!heroVisible} />

      <div ref={heroRef} className="flex items-center gap-4 pb-4">
        <ProviderTile
          driver={driver}
          label={label}
          iconUrl={(snapshot as any).iconUrl ?? null}
          size="hero"
          pulse={showReady}
        />
        <div className="min-w-0">
          <h2 className="text-2xl leading-7 font-bold text-[var(--personal-text)]">{label}</h2>
          {publisher !== null ? (
            <p className="text-[14px] leading-4.75 text-[var(--personal-text-secondary)]">
              {publisher}
            </p>
          ) : null}
        </div>
      </div>

      {before ? (
        <BeforeInstall
          label={label}
          facts={facts}
          canInstall={setup?.canInstall === true}
          totalBytes={install?.totalBytes ?? null}
          version={snapshot.versionAdvisory?.latestVersion ?? install?.version ?? null}
          onInstall={() => setSheet("install")}
          keyEntry={
            driver === "deepseek" && keyField !== undefined ? (
              <ProviderKeyEntry
                field={keyField}
                environment={environmentVariables}
                enabled={snapshot.enabled}
                balance={snapshot.usageBalance}
                mode="setup"
                onChange={(next) => instanceSettings.setEnvironment(next, true)}
                onSaved={onCheckAgain}
              />
            ) : null
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          {showSetup ? (
            <SetupCard
              steps={steps}
              label={label}
              environmentId={environmentId}
              instanceId={instanceId}
              snapshot={snapshot}
              kind={kind}
              auth={auth}
              install={install ?? null}
              startingInstall={startingInstall}
              autoStartSignIn={action === "signIn"}
              testing={smoke?.status === "checking"}
              testNote={note}
              noteButtonLabel={noteButtonLabel}
              onNoteButton={onNoteButton}
              environmentVariables={environmentVariables}
              setEnvironment={instanceSettings.setEnvironment}
              onKeySaved={onCheckAgain}
              onCancelInstall={cancelInstallNow}
              model={
                smoke?.model ?? snapshot.models.find((m) => m.isDefault === true)?.name ?? null
              }
            />
          ) : null}

          {showReady ? (
            <ReadyBlock
              label={label}
              line={canTest ? answeredLine(smoke, snapshot.models) : "Installed and signed in"}
              tested={canTest}
            />
          ) : null}

          {!showSetup && (!showReady || note !== null) ? (
            <StatusBlock
              row={row}
              note={note}
              noteButtonLabel={noteButtonLabel}
              onNoteButton={onNoteButton}
              onAction={() => {
                if (row.action?.kind === "update") onUpdate();
                else onCheckAgain();
              }}
              canCheck={!row.busy}
              onCheckAgain={onCheckAgain}
            />
          ) : null}

          {installed && !showSetup ? (
            <AccountSection
              label={label}
              snapshot={snapshot}
              kind={kind}
              canSignOutOfProvider={setup?.canAuthenticate === true}
              onSignOut={() => setSheet("signOut")}
              keyEntry={
                keyField !== undefined ? (
                  keyField.required || addingKey || hasKey(environmentVariables, keyField.name) ? (
                    <ProviderKeyEntry
                      field={keyField}
                      environment={environmentVariables}
                      enabled={snapshot.enabled}
                      balance={snapshot.usageBalance}
                      mode="account"
                      onChange={instanceSettings.setEnvironment}
                      onSaved={onCheckAgain}
                    />
                  ) : (
                    <CardRow
                      title={keyField.label}
                      hint="Optional · you can sign in without one"
                      control={
                        <button
                          type="button"
                          onClick={() => setAddingKey(true)}
                          className={BUTTON_OUTLINE}
                        >
                          Add key
                        </button>
                      }
                    />
                  )
                ) : null
              }
              serverRow={
                driver === "opencode" ? (
                  <OpenCodeServerRow
                    url={serverUrl}
                    hasPassword={
                      typeof instanceConfig?.serverPassword === "string" &&
                      instanceConfig.serverPassword.trim().length > 0
                    }
                    editing={editingServer}
                    onEdit={() => setEditingServer(true)}
                    onCancel={() => setEditingServer(false)}
                    onSave={(next) => {
                      instanceSettings.setConfig({ serverUrl: next.length > 0 ? next : undefined });
                      setEditingServer(false);
                      onCheckAgain();
                    }}
                  />
                ) : null
              }
            />
          ) : null}

          {installed ? (
            <UseSection
              label={label}
              enabled={enabledShown}
              onEnabled={toggleEnabled}
              showUsage={providerReportsUsage(snapshot)}
              usageShown={usageShown}
              usageBusy={usagePending !== null}
              onUsage={(next) => void toggleUsage(next)}
              canRemove={canRemove}
            />
          ) : null}

          {showReady ? <ReadyButtons instanceId={instanceId} returnTarget={returnTarget} /> : null}

          {installed && snapshot.models.length > 0 ? (
            <ModelsSection
              snapshot={snapshot}
              bots={bots}
              showAll={showAllModels}
              onShowAll={() => setShowAllModels((previous) => !previous)}
            />
          ) : null}

          {installed && canTest && !showSetup ? (
            <section aria-labelledby="provider-test">
              <h3 id="provider-test" className={SECTION_TITLE}>
                Test
              </h3>
              <div className={CARD}>
                <CardRow
                  title="Send a test message"
                  hint={testLine(smoke) ?? "Asks for one word and checks the answer"}
                  control={
                    <button
                      type="button"
                      onClick={onTest}
                      disabled={row.busy || !snapshot.enabled}
                      aria-busy={smoke?.status === "checking" || pending?.kind === "test"}
                      className={BUTTON_OUTLINE}
                    >
                      Test
                    </button>
                  }
                />
              </div>
            </section>
          ) : null}

          {installed && !showSetup ? (
            <VersionSection
              snapshot={snapshot}
              nowMs={nowMs}
              goBackVersion={
                row.state === "updateBroke" && row.action?.kind === "goBack"
                  ? goBackVersion
                  : undefined
              }
              onGoBack={onGoBack}
              busy={row.busy}
            />
          ) : null}

          {canRemove && !installActive && !startingInstall ? (
            <section>
              <button
                type="button"
                onClick={() => setSheet("remove")}
                className="flex min-h-12 w-full items-center gap-3 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-4 text-left text-[15px] font-semibold text-[var(--personal-error)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
              >
                <Trash2 aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
                Remove {label}
              </button>
              <p className="mt-2 px-1 text-[13px] text-[var(--personal-text-secondary)]">
                Deletes it from your laptop. Bots that use it stop until you pick another model.
              </p>
            </section>
          ) : installed && !showSetup ? (
            <p className="px-1 text-[13px] text-[var(--personal-text-secondary)]">
              Built in providers can be turned off, not removed.
            </p>
          ) : null}
        </div>
      )}

      {error !== null ? (
        <div className="mt-4">
          <ProviderNote
            tone="danger"
            title="Something went wrong"
            actions={
              <button type="button" onClick={() => setError(null)} className={BUTTON_OUTLINE}>
                Dismiss
              </button>
            }
          >
            {error.split(/\r?\n/)[0]?.slice(0, 160)}
          </ProviderNote>
        </div>
      ) : null}

      {sheet === "install" ? (
        <InstallConfirmSheet
          driver={driver}
          label={label}
          iconUrl={(snapshot as any).iconUrl ?? null}
          facts={facts}
          version={snapshot.versionAdvisory?.latestVersion ?? install?.version ?? null}
          totalBytes={install?.totalBytes ?? null}
          builtIn
          error={sheetError}
          busy={sheetBusy}
          onConfirm={() => void confirmInstall()}
          onCancel={() => {
            setSheet(null);
            setSheetError(null);
          }}
        />
      ) : null}
      {sheet === "remove" ? (
        <ConfirmSheet
          driver={driver}
          label={label}
          iconUrl={(snapshot as any).iconUrl ?? null}
          title={`Remove ${label}?`}
          subtitle="From your laptop"
          body={
            <>
              {users.length > 0
                ? `${botsNamed(users)} ${users.length === 1 ? "uses it and can't reply" : "use it and can't reply"} until you give ${users.length === 1 ? "it" : "them"} another model. `
                : ""}
              Your sign-in for {label} is kept; remove it with Sign out first if you want it gone.
              {sheetError !== null ? (
                <span role="alert" className="mt-2 block text-[var(--personal-error)]">
                  {sheetError}
                </span>
              ) : null}
            </>
          }
          confirmLabel="Remove"
          destructive
          busy={sheetBusy}
          onConfirm={() => void confirmRemove()}
          onCancel={() => {
            setSheet(null);
            setSheetError(null);
          }}
        />
      ) : null}
      {sheet === "turnOff" ? (
        <ConfirmSheet
          driver={driver}
          label={label}
          title={`Turn off ${label}?`}
          subtitle="Bots can't use it while it's off"
          body={`${botsNamed(users)} ${users.length === 1 ? "uses it and can't reply" : "use it and can't reply"} until you turn it back on or give ${users.length === 1 ? "it" : "them"} another model.`}
          confirmLabel="Turn off"
          destructive
          onConfirm={confirmTurnOff}
          onCancel={() => setSheet(null)}
        />
      ) : null}
      {sheet === "signOut" ? (
        <ConfirmSheet
          driver={driver}
          label={label}
          title={`Sign out of ${label}?`}
          subtitle="On your laptop"
          body={
            <>
              This stops its running chats. Chat history is kept, and you can sign in again any
              time.
              {sheetError !== null ? (
                <span role="alert" className="mt-2 block text-[var(--personal-error)]">
                  {sheetError}
                </span>
              ) : null}
            </>
          }
          confirmLabel="Sign out"
          destructive
          busy={sheetBusy}
          onConfirm={() => void confirmSignOut()}
          onCancel={() => {
            setSheet(null);
            setSheetError(null);
          }}
        />
      ) : null}
      {sheet === "remap" ? (
        <RemapSheet
          snapshot={snapshot}
          label={label}
          bots={affectedBots}
          busy={sheetBusy}
          error={sheetError}
          onApply={(model) => void applyRemap(model)}
          onCancel={() => {
            setSheet(null);
            setSheetError(null);
          }}
        />
      ) : null}
    </div>
  );
}

function hasKey(environment: ReadonlyArray<{ readonly name: string }>, name: string): boolean {
  return environment.some((variable) => variable.name === name);
}

/** The product page before install (SPEC 5.1): what it is, what it costs, the install button. */
function BeforeInstall({
  label,
  facts,
  canInstall,
  totalBytes,
  version,
  onInstall,
  keyEntry,
}: {
  label: string;
  facts: ReturnType<typeof providerFacts>;
  canInstall: boolean;
  totalBytes: number | null;
  version: string | null;
  onInstall: () => void;
  keyEntry: ReactNode;
}): JSX.Element {
  const licence = licenceLine(facts);
  const details: ReadonlyArray<{ key: string; value: string }> = [
    ...(facts?.signIn != null ? [{ key: "Sign in", value: facts.signIn }] : []),
    ...(version !== null ? [{ key: "Version", value: version }] : []),
    ...(canInstall ? [{ key: "Download", value: downloadLine(totalBytes) }] : []),
    ...(facts?.from != null ? [{ key: "From", value: facts.from }] : []),
    ...(licence !== null ? [{ key: "Licence", value: licence }] : []),
  ];
  return (
    <div className="flex flex-col gap-6">
      {facts !== null ? (
        <p className="-mt-1 text-[15px] leading-[21px] text-[var(--personal-text)]">
          {facts.description}
        </p>
      ) : null}
      <section aria-labelledby="provider-cost">
        <h3 id="provider-cost" className={SECTION_TITLE}>
          What it costs
        </h3>
        <div className={`${CARD} px-4 py-3`}>
          {facts?.cost != null ? (
            <>
              <p className="text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
                {facts.cost.label}
              </p>
              {facts.cost.detail !== null ? (
                <p className="mt-0.5 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
                  {facts.cost.detail}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-[14px] leading-5 text-[var(--personal-text-secondary)]">
              Price not listed. You'll see the sign-in choices after it's installed.
            </p>
          )}
        </div>
      </section>
      {details.length > 0 ? (
        <section aria-labelledby="provider-details">
          <h3 id="provider-details" className={SECTION_TITLE}>
            Details
          </h3>
          <dl className={`${CARD} divide-y divide-[var(--personal-border)]`}>
            {details.map((detail) => (
              <div
                key={detail.key}
                className="flex min-h-12 items-center justify-between gap-4 px-4"
              >
                <dt className="shrink-0 text-[15px] text-[var(--personal-text-secondary)]">
                  {detail.key}
                </dt>
                <dd className="min-w-0 text-right text-[15px] break-words text-[var(--personal-text)]">
                  {detail.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      {keyEntry !== null ? (
        keyEntry
      ) : canInstall ? (
        <div className="sticky bottom-[max(0.75rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-[var(--personal-bg)] via-[var(--personal-bg)] to-transparent pt-6">
          <button
            type="button"
            onClick={onInstall}
            className={`${BUTTON_BIG} bg-[var(--personal-primary)] text-[var(--personal-primary-text)]`}
          >
            Install {label}
          </button>
        </div>
      ) : (
        <ProviderNote tone="info" title="Install it on your computer">
          {label} can't be installed from the phone yet. Once it's installed on your laptop it shows
          up here by itself.
        </ProviderNote>
      )}
    </div>
  );
}

/** The step marker: done (filled check), now (ring + number), next (quiet ring), failed. */
function StepMarker({
  index,
  status,
}: {
  index: number;
  status: SetupStep["status"];
}): JSX.Element {
  const base =
    "flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold";
  if (status === "done") {
    return (
      <span
        aria-hidden="true"
        className={`${base} bg-[var(--personal-text)] text-[var(--personal-bg)]`}
      >
        <Check className="size-4" strokeWidth={2.5} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        aria-hidden="true"
        className={`${base} bg-[var(--personal-danger-bg)] text-[var(--personal-danger)]`}
      >
        !
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${base} ${status === "now" ? "border-2 border-[var(--personal-text)] text-[var(--personal-text)]" : "border-[1.5px] border-[var(--personal-border-strong)] text-[var(--personal-text-secondary)]"}`}
    >
      {index + 1}
    </span>
  );
}

function SetupCard({
  steps,
  label,
  environmentId,
  instanceId,
  snapshot,
  kind,
  auth,
  install,
  startingInstall,
  autoStartSignIn,
  testing,
  testNote,
  noteButtonLabel,
  onNoteButton,
  environmentVariables,
  setEnvironment,
  onKeySaved,
  onCancelInstall,
  model,
}: {
  steps: ReadonlyArray<SetupStep>;
  label: string;
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  snapshot: ServerProvider;
  kind: SignInKind;
  auth: ProviderAuthState | null;
  install: ProviderInstallState | null;
  startingInstall: boolean;
  autoStartSignIn: boolean;
  testing: boolean;
  testNote: ReturnType<typeof pageNote>;
  noteButtonLabel: (button: NoteButton) => string;
  onNoteButton: (button: NoteButton) => void;
  environmentVariables: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  setEnvironment: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
  onKeySaved: () => void;
  onCancelInstall: () => void;
  model: string | null;
}): JSX.Element {
  const keyField = providerApiKeyField(snapshot.driver);
  const phaseLine =
    install?.phase === "extracting"
      ? "Unpacking"
      : install?.phase === "verifying"
        ? "Checking the download"
        : (install?.phase as string) === "starting"
          ? "Checking it starts"
          : "Downloading";
  const total = install?.totalBytes ?? null;
  const downloaded = install?.downloadedBytes ?? 0;
  const fraction =
    install?.phase === "downloading" && total !== null && total > 0
      ? Math.min(1, downloaded / total)
      : null;
  const sizeText =
    install?.phase === "downloading" && total !== null && total > 0
      ? `${Math.round(downloaded / 1_000_000)} of ${Math.round(total / 1_000_000)} MB`
      : "";
  return (
    <section aria-label="Setup" className={`${CARD} px-4`} data-setup-card>
      <ol role="list" className="flex flex-col">
        {steps.map((step, index) => (
          <li
            key={step.key}
            aria-current={step.status === "now" || step.status === "failed" ? "step" : undefined}
            className={index > 0 ? "border-t border-[var(--personal-border)]" : ""}
          >
            <div className="flex min-h-14 items-center gap-3">
              <StepMarker index={index} status={step.status} />
              <span
                className={`min-w-0 flex-1 text-[16px] leading-[21px] ${
                  step.status === "now" || step.status === "failed"
                    ? "font-semibold text-[var(--personal-text)]"
                    : step.status === "done"
                      ? "font-medium text-[var(--personal-text)]"
                      : "font-medium text-[var(--personal-text-secondary)]"
                }`}
              >
                {step.title}
              </span>
              {step.note !== null ? (
                <span className="shrink-0 text-[13px] text-[var(--personal-text-secondary)] tabular-nums">
                  {step.note}
                </span>
              ) : null}
            </div>
            {step.key === "install" && (step.status === "now" || step.status === "failed") ? (
              <div className="pb-4 pl-10">
                {install?.phase === "failed" ? (
                  (() => {
                    const failNote = catalogInstallFailureNote(
                      (install as any)?.failure ?? null,
                      install.message,
                      label,
                    );
                    return (
                      <ProviderNote
                        tone={failNote.tone}
                        title={failNote.title}
                        actions={failNote.buttons.map((btn) => (
                          <button
                            key={btn}
                            type="button"
                            onClick={() =>
                              onNoteButton(btn === "removeIt" ? "removeIt" : "tryAgain")
                            }
                            className={btn === "removeIt" ? BUTTON_OUTLINE : BUTTON_PRIMARY}
                          >
                            {btn === "removeIt" ? "Remove it" : "Try again"}
                          </button>
                        ))}
                      >
                        {failNote.text}
                      </ProviderNote>
                    );
                  })()
                ) : (
                  <>
                    <div className="flex items-baseline justify-between gap-3 text-[14px]">
                      <span className="font-semibold text-[var(--personal-text)]">
                        {startingInstall && install === null ? "Starting" : phaseLine}
                      </span>
                      <span className="text-[var(--personal-text-secondary)] tabular-nums">
                        {sizeText}
                      </span>
                    </div>
                    <div className="mt-2">
                      <ProgressBar
                        fraction={fraction}
                        label={`${label} install`}
                        valueText={sizeText === "" ? phaseLine : sizeText}
                      />
                    </div>
                    <p className="mt-3 text-[14px] leading-5 text-[var(--personal-text-secondary)]">
                      You can leave this page. It keeps going, and Settings shows the progress.
                    </p>
                    {install?.operationId != null ? (
                      <button
                        type="button"
                        onClick={onCancelInstall}
                        className={`${BUTTON_OUTLINE} mt-3`}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
            {step.key === "signIn" && step.status === "now" ? (
              <div className="pb-4 pl-10">
                {kind === "redirect" ? (
                  <SignInRedirect
                    environmentId={environmentId}
                    instanceId={instanceId}
                    auth={auth}
                    providerLabel={label === "Antigravity" ? "Google" : label}
                    canOpenOnLaptop={snapshot.setup?.canOpenOnLaptop === true}
                    autoStart={autoStartSignIn}
                  />
                ) : kind === "key" && keyField !== undefined ? (
                  <ProviderKeyEntry
                    field={keyField}
                    environment={environmentVariables}
                    enabled={snapshot.enabled}
                    balance={snapshot.usageBalance}
                    mode="setup"
                    onChange={setEnvironment}
                    onSaved={onKeySaved}
                  />
                ) : (
                  <div className="flex flex-col gap-3">
                    <p className="text-[15px] leading-[21px] text-[var(--personal-text-secondary)]">
                      {label} signs in on your laptop.
                    </p>
                    <p className="flex gap-2.5 text-[15px] leading-[21px] text-[var(--personal-text)]">
                      <Laptop
                        aria-hidden="true"
                        className="mt-0.5 size-5 shrink-0"
                        strokeWidth={1.75}
                      />
                      <span>
                        {LAPTOP_SIGN_IN[snapshot.driver] ?? `Sign in to ${label} on your laptop.`}
                      </span>
                    </p>
                    <p className="text-[13px] text-[var(--personal-text-secondary)]">
                      This page moves on by itself once it sees you signed in.
                    </p>
                  </div>
                )}
              </div>
            ) : null}
            {step.key === "test" && (step.status === "now" || step.status === "failed") ? (
              <div className="pb-4 pl-10">
                {testNote !== null && step.status === "failed" ? (
                  <ProviderNote
                    tone={testNote.tone}
                    title={testNote.title}
                    actions={testNote.buttons.map((button, buttonIndex) => (
                      <button
                        key={button}
                        type="button"
                        onClick={() => onNoteButton(button)}
                        className={buttonIndex === 0 ? BUTTON_PRIMARY : BUTTON_OUTLINE}
                      >
                        {noteButtonLabel(button)}
                      </button>
                    ))}
                  >
                    {testNote.text}
                  </ProviderNote>
                ) : (
                  <p
                    role="status"
                    className="flex items-center gap-2.5 text-[15px] leading-[21px] text-[var(--personal-text-secondary)]"
                  >
                    <StatusDot dot={testing ? "spinner" : "none"} />
                    {model !== null
                      ? `Sending one message to ${model}…`
                      : "Sending one message…"}{" "}
                    Usually under 30 seconds.
                  </p>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReadyBlock({
  label,
  line,
  tested,
}: {
  label: string;
  line: string | null;
  tested: boolean;
}): JSX.Element {
  return (
    <section aria-label="Ready" className={`${CARD} px-4 py-4`} data-ready>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--personal-live)] text-[var(--personal-bg)]"
        >
          <Check className="size-4" strokeWidth={2.5} />
        </span>
        <div className="min-w-0">
          <p className="text-[16px] leading-[21px] font-semibold text-[var(--personal-text)]">
            {label} is ready
          </p>
          {line !== null ? (
            <p className="text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
              {line}
            </p>
          ) : null}
        </div>
      </div>
      {tested ? (
        <p className="mt-3 rounded-[10px] bg-[var(--personal-fill-muted)] px-3 py-2 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
          We asked for one word. It answered.
        </p>
      ) : null}
    </section>
  );
}

function ReadyButtons({
  instanceId,
  returnTarget,
}: {
  readonly instanceId: string;
  readonly returnTarget?: string | undefined;
}): JSX.Element {
  const href = `/bots/new?provider=${encodeURIComponent(instanceId)}`;
  return (
    <div className="flex flex-col gap-2">
      <Link
        to={href}
        className={`${BUTTON_BIG} bg-[var(--personal-primary)] text-[var(--personal-primary-text)]`}
      >
        Make a bot with it
      </Link>
      <Link
        to={returnTarget === "botform" ? href : "/bots/settings"}
        className={`${BUTTON_BIG} bg-[var(--personal-fill-muted)] text-[var(--personal-text)]`}
      >
        Done
      </Link>
    </div>
  );
}

function StatusBlock({
  row,
  note,
  noteButtonLabel,
  onNoteButton,
  onAction,
  canCheck,
  onCheckAgain,
}: {
  row: ProviderRow;
  note: ReturnType<typeof pageNote>;
  noteButtonLabel: (button: NoteButton) => string;
  onNoteButton: (button: NoteButton) => void;
  onAction: () => void;
  canCheck: boolean;
  onCheckAgain: () => void;
}): JSX.Element {
  if (note !== null) {
    return (
      <ProviderNote
        tone={note.tone}
        title={note.title}
        actions={note.buttons.map((button, index) => (
          <button
            key={button}
            type="button"
            onClick={() => onNoteButton(button)}
            className={index === 0 ? BUTTON_PRIMARY : BUTTON_OUTLINE}
          >
            {noteButtonLabel(button)}
          </button>
        ))}
      >
        {note.text}
      </ProviderNote>
    );
  }
  return (
    <section aria-label="Status" className={CARD} data-provider-state={row.state}>
      <div className="flex min-h-[66px] items-center gap-3 px-4 py-2.5">
        <StatusDot dot={row.dot === "none" ? "waiting" : row.dot} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
            {stateWord(row)}
          </span>
          <span className="text-[13px] leading-[18px] break-words text-[var(--personal-text-secondary)]">
            {row.statusText}
          </span>
          {row.detail !== null ? (
            <span className="text-[13px] leading-[18px] break-words text-[var(--personal-text-secondary)]">
              {row.detail}
            </span>
          ) : null}
        </span>
        {row.action !== null && row.action.kind === "update" ? (
          <button type="button" onClick={onAction} className={BUTTON_PRIMARY}>
            {row.action.label}
          </button>
        ) : (
          <button
            type="button"
            onClick={onCheckAgain}
            disabled={!canCheck}
            className={BUTTON_OUTLINE}
          >
            Check again
          </button>
        )}
      </div>
      {row.progress !== null ? (
        <div className="px-4 pb-3">
          <ProgressBar
            fraction={row.progress.fraction}
            label={row.statusText}
            valueText={row.statusText}
          />
        </div>
      ) : null}
    </section>
  );
}

function AccountSection({
  label,
  snapshot,
  kind,
  canSignOutOfProvider,
  onSignOut,
  keyEntry,
  serverRow,
}: {
  label: string;
  snapshot: ServerProvider;
  kind: SignInKind;
  canSignOutOfProvider: boolean;
  onSignOut: () => void;
  keyEntry: ReactNode;
  serverRow: ReactNode;
}): JSX.Element | null {
  const signedIn = snapshot.auth.status === "authenticated";
  const accountLabel = snapshot.auth.label ?? snapshot.auth.type ?? null;
  const accountTitle = kind === "redirect" ? "Google account" : `${label} account`;
  if (kind === "key" && keyEntry === null && serverRow === null) return null;
  return (
    <section aria-labelledby="provider-account">
      <h3 id="provider-account" className={SECTION_TITLE}>
        Account
      </h3>
      <div className={`${CARD} divide-y divide-[var(--personal-border)]`}>
        {kind !== "key" || !signedIn ? (
          <CardRow
            title={accountTitle}
            hint={
              signedIn
                ? `Signed in${accountLabel !== null ? ` · ${accountLabel}` : ""}`
                : snapshot.auth.status === "unauthenticated"
                  ? "Not signed in"
                  : "Sign-in status not reported"
            }
            control={
              canSignOutOfProvider && signedIn ? (
                <button type="button" onClick={onSignOut} className={BUTTON_QUIET}>
                  Sign out
                </button>
              ) : undefined
            }
          />
        ) : null}
        {keyEntry}
        {serverRow}
      </div>
    </section>
  );
}

function OpenCodeServerRow({
  url,
  hasPassword,
  editing,
  onEdit,
  onCancel,
  onSave,
}: {
  url: string;
  hasPassword: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (url: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(url);
  const problem =
    draft.trim().length === 0
      ? null
      : (() => {
          try {
            const parsed = new URL(draft.trim());
            return parsed.protocol === "http:" || parsed.protocol === "https:"
              ? null
              : "Use an address that starts with http:// or https://";
          } catch {
            return "That isn't an address. It looks like http://127.0.0.1:4096";
          }
        })();
  if (!editing) {
    return (
      <CardRow
        title="OpenCode server"
        hint={url.length > 0 ? `Connected · ${url}` : "hbots runs it on your laptop"}
        control={
          <button type="button" onClick={onEdit} className={BUTTON_OUTLINE}>
            Change
          </button>
        }
      />
    );
  }
  return (
    <div className="px-4 py-3">
      <p className="text-[15px] leading-[21px] text-[var(--personal-text-secondary)]">
        hbots runs OpenCode's server on your laptop. Leave the address empty unless yours runs
        somewhere else.
      </p>
      <label
        htmlFor="opencode-server"
        className="mt-3 mb-1.5 block text-sm font-medium text-[var(--personal-text)]"
      >
        Server address
      </label>
      <input
        id="opencode-server"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        type="url"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="http://127.0.0.1:4096"
        aria-invalid={problem !== null}
        className="h-11 w-full min-w-0 rounded-[var(--personal-radius-button)] border border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] px-3.5 font-mono text-[14px] text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      />
      {problem !== null ? (
        <p role="alert" className="mt-2 text-[14px] text-[var(--personal-error)]">
          {problem}
        </p>
      ) : null}
      {hasPassword ? (
        <p className="mt-2 text-[13px] text-[var(--personal-text-secondary)]">
          A server password is set on your computer.
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={problem !== null}
          onClick={() => onSave(draft.trim())}
          className={`${BUTTON_PRIMARY} flex-1`}
        >
          Connect
        </button>
        <button type="button" onClick={onCancel} className={BUTTON_OUTLINE}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function UseSection({
  label,
  enabled,
  onEnabled,
  showUsage,
  usageShown,
  usageBusy,
  onUsage,
  canRemove,
}: {
  label: string;
  enabled: boolean;
  onEnabled: (next: boolean) => void;
  showUsage: boolean;
  usageShown: boolean;
  usageBusy: boolean;
  onUsage: (next: boolean) => void;
  canRemove: boolean;
}): JSX.Element {
  void canRemove;
  return (
    <section aria-labelledby="provider-use">
      <h3 id="provider-use" className={SECTION_TITLE}>
        Use
      </h3>
      <div className={`${CARD} divide-y divide-[var(--personal-border)]`}>
        <CardRow
          title="Use for bots"
          hint="Its models show in the bot form"
          control={
            <ProviderSwitch
              checked={enabled}
              onChange={onEnabled}
              label={`Use ${label} for bots`}
            />
          }
        />
        {showUsage ? (
          <CardRow
            title="Show usage"
            hint="Its limits on the Bots page"
            control={
              <ProviderSwitch
                checked={usageShown}
                onChange={onUsage}
                label={`Show ${label} usage`}
                busy={usageBusy}
                disabled={usageBusy}
              />
            }
          />
        ) : null}
      </div>
    </section>
  );
}

function ModelsSection({
  snapshot,
  bots,
  showAll,
  onShowAll,
}: {
  snapshot: ServerProvider;
  bots: ReadonlyArray<PersonalBot>;
  showAll: boolean;
  onShowAll: () => void;
}): JSX.Element {
  const models = snapshot.models.toSorted(
    (left, right) => Number(right.isDefault === true) - Number(left.isDefault === true),
  );
  const shown = showAll ? models : models.slice(0, 3);
  return (
    <section aria-labelledby="provider-models">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h3
          id="provider-models"
          className="text-[13px] font-semibold tracking-wide text-[var(--personal-section-label)] uppercase"
        >
          Models
        </h3>
        <span className="text-[13px] text-[var(--personal-text-secondary)]">{models.length}</span>
      </div>
      <ul className={`${CARD} divide-y divide-[var(--personal-border)]`}>
        {shown.map((model) => {
          const names = botsUsingModels(snapshot.instanceId, [model.slug], bots).map(
            (bot) => bot.name,
          );
          const hint = [model.isDefault === true ? "Default" : null, botsUseText(names)]
            .filter((part): part is string => part !== null)
            .join(" · ");
          return (
            <li key={model.slug} className="flex min-h-14 flex-col justify-center px-4 py-2">
              <span className="text-[15px] leading-5 text-[var(--personal-text)]">
                {model.name}
              </span>
              {hint.length > 0 ? (
                <span className="text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
                  {hint}
                </span>
              ) : null}
            </li>
          );
        })}
        {models.length > 3 ? (
          <li>
            <button
              type="button"
              onClick={onShowAll}
              aria-expanded={showAll}
              className="flex min-h-12 w-full items-center justify-between px-4 text-left text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
            >
              {showAll ? "Show fewer" : `Show all ${models.length}`}
              <ChevronRight
                aria-hidden="true"
                className={`size-5 text-[var(--personal-text-secondary)] ${showAll ? "rotate-90" : ""}`}
                strokeWidth={1.75}
              />
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function VersionSection({
  snapshot,
  nowMs,
  goBackVersion,
  onGoBack,
  busy,
}: {
  snapshot: ServerProvider;
  nowMs: number;
  goBackVersion: string | undefined;
  onGoBack: () => void;
  busy: boolean;
}): JSX.Element {
  const advisory = snapshot.versionAdvisory;
  const checked = timeAgo(advisory?.checkedAt, nowMs);
  const status =
    advisory?.status === "current"
      ? `Up to date${checked !== null ? ` · checked ${checked}` : ""}`
      : advisory?.status === "behind_latest"
        ? advisory.latestVersion !== null
          ? `New version ${advisory.latestVersion}`
          : "A new version is out"
        : "Version check not available";
  return (
    <section aria-labelledby="provider-version">
      <h3 id="provider-version" className={SECTION_TITLE}>
        Version
      </h3>
      <div className={`${CARD} divide-y divide-[var(--personal-border)]`}>
        <CardRow
          title={<span className="tabular-nums">{snapshot.version ?? "Not reported"}</span>}
          hint={status}
          control={
            goBackVersion !== undefined ? (
              <button type="button" onClick={onGoBack} disabled={busy} className={BUTTON_OUTLINE}>
                Go back
              </button>
            ) : undefined
          }
        />
        <CardRow title="Source" hint="Built into hbots" />
      </div>
    </section>
  );
}
