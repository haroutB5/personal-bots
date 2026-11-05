import type {
  EnvironmentId,
  ProviderInstanceConfig,
  ServerSettingsPatch,
  ServerProvider,
} from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  hasSavedProviderApiKey,
  providerApiKeyField,
  withProviderApiKey,
  withoutProviderApiKey,
} from "@hbots/personal-client/settings/providerApiKeys";
import { botsUsingProvider } from "@hbots/personal-client/settings/providerRows";
import { useState } from "react";
import { ActivityIndicator, Linking, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useSecretDraft } from "../platform/useSecretDraft";
import { useSecureScreen } from "../platform/secureScreen";
import { tokens } from "../shell/tokens";
import {
  Field,
  Notice,
  PrimaryButton,
  Row,
  Section,
  SectionNote,
  SettingsPage,
  TextButton,
  ToggleRow,
} from "./SettingsUi";
import {
  instanceConfigOf,
  modelsShown,
  providerPriceLine,
  providerScreenModel,
  providerSourceLine,
  versionLine,
} from "./providerScreenModel";
import { InstallConfirmSheet, ProviderConfirmSheet, RemapSheet } from "./ProviderSheets";

type SheetKind = "install" | "remove" | "signOut" | "turnOff" | "remap" | null;

export function ProviderScreen({
  native,
  instanceId,
  onBack,
}: {
  readonly native: NativePersonal;
  readonly instanceId: string;
  readonly onBack: () => void;
}) {
  const environmentId = native.environmentId as EnvironmentId;
  const providers = native.useProviders();
  const bots = native.bots.usePersonalBotsList(environmentId);
  const settings = native.providers.useServerSettings(environmentId);
  const install = native.providers.useProviderInstallState(environmentId, instanceId as never);
  const writeSettings = native.providers.useProviderSettingsWriter(environmentId);
  const startInstall = native.client.useAtomCommand(native.providers.startProviderInstall, {
    reportFailure: false,
  });
  const removeInstall = native.client.useAtomCommand(native.providers.removeProviderInstall, {
    reportFailure: false,
  });
  const runTest = native.client.useAtomCommand(native.providers.runProviderTest, {
    reportFailure: false,
  });
  const startAuth = native.client.useAtomCommand(native.providers.startProviderAuth, {
    reportFailure: false,
  });
  const logoutAuth = native.client.useAtomCommand(native.providers.logoutProviderAuth, {
    reportFailure: false,
  });
  const updateProvider = native.client.useAtomCommand(native.providers.updateProvider, {
    reportFailure: false,
  });
  const recheck = native.client.useAtomCommand(native.bots.personalProviderRecheck, {
    reportFailure: false,
  });
  const updateBot = native.client.useAtomCommand(native.bots.personalBotUpdate, {
    reportFailure: false,
  });
  const setProfile = native.client.useAtomCommand(native.bots.personalProfileSet, {
    reportFailure: false,
  });
  const catalogId = providers.find((candidate) => candidate.instanceId === instanceId)?.catalogId;
  const facts = native.providers.useProviderInstallFacts(environmentId, catalogId ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [expanded, setExpanded] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyDraft, setKeyDraft, clearKeyDraft] = useSecretDraft();
  const snapshot = providers.find((candidate) => candidate.instanceId === instanceId) ?? null;
  const keyField = snapshot === null ? undefined : providerApiKeyField(snapshot.driver);
  useSecureScreen(keyField !== undefined);

  if (snapshot === null) {
    return (
      <SettingsPage title="Provider" onBack={onBack}>
        <Section label="Provider">
          <Row title="This provider isn't set up on your computer." />
        </Section>
      </SettingsPage>
    );
  }

  const model = providerScreenModel({
    snapshot,
    bots: bots.data?.bots ?? [],
    install: install.data ?? null,
  });
  const instance = instanceConfigOf(settings.data, instanceId, snapshot.driver);
  const environment = instance?.environment ?? [];
  const savedKey = keyField === undefined ? false : hasSavedProviderApiKey(environment, keyField);

  const run = async (
    nextBusy: string,
    call: () => Promise<AtomCommandResult<unknown, unknown> | null>,
    fallback: string,
    onSuccess?: () => void,
  ) => {
    setBusy(nextBusy);
    setError(null);
    setNotice(null);
    const result = await call();
    const failure =
      result === null ? "Not connected to your computer." : commandFailureMessage(result, fallback);
    if (failure === null) onSuccess?.();
    else setError(failure);
    setBusy(null);
    return failure;
  };

  const writeInstance = async (next: ProviderInstanceConfig): Promise<string | null> => {
    const patch: ServerSettingsPatch = {
      providerInstances: {
        ...settings.data?.providerInstances,
        [instanceId]: { ...next, driver: snapshot.driver },
      },
    };
    const result = await writeSettings(patch);
    return result === null
      ? "Not connected to your computer."
      : commandFailureMessage(result, "Couldn't save the provider setting.");
  };

  const enableThenInstall = async () => {
    setBusy("install");
    setError(null);
    const enableFailure = await writeInstance({
      driver: snapshot.driver,
      enabled: true,
      config: instance?.config ?? {},
      environment,
    });
    if (enableFailure !== null) {
      setError(enableFailure);
      setBusy(null);
      return;
    }
    const result = await startInstall({
      environmentId,
      input: { instanceId: instanceId as never },
    });
    const failure =
      result === null
        ? "Not connected to your computer."
        : commandFailureMessage(result, `Couldn't start the ${model.label} install.`);
    if (failure === null) {
      setSheet(null);
      setNotice("Install started. You can leave this page; Settings shows the progress.");
    } else {
      setError(failure);
    }
    setBusy(null);
  };

  const act = () => {
    const action = model.row.action;
    if (action === null) return;
    switch (action.kind) {
      case "install":
        setSheet("install");
        return;
      case "signIn":
        if (snapshot.setup?.canAuthenticate === true) {
          void run(
            "signIn",
            () => startAuth({ environmentId, input: { instanceId: instanceId as never } }),
            `Couldn't start ${model.label} sign-in.`,
            () => setNotice("Sign-in is open. Finish it on your laptop, then tap Test."),
          ).then((failure) => {
            if (failure !== null) return;
          });
          return;
        }
        if (keyField !== undefined) {
          setKeyOpen(true);
          return;
        }
        setError(`${model.label} signs in on your laptop.`);
        return;
      case "fix":
        setSheet("remap");
        return;
      case "update":
      case "goBack":
        void run(
          action.kind,
          () =>
            updateProvider({
              environmentId,
              input: {
                provider: snapshot.driver,
                instanceId: instanceId as never,
                ...(action.kind === "goBack" &&
                snapshot.previousVersion !== null &&
                snapshot.previousVersion !== undefined
                  ? { targetVersion: snapshot.previousVersion, rollback: true }
                  : {}),
              },
            }),
          `Couldn't start the ${model.label} update.`,
        );
        return;
      case "tryAgain":
        if (model.row.state === "installFailed") {
          void run(
            "tryAgain",
            () => startInstall({ environmentId, input: { instanceId: instanceId as never } }),
            `Couldn't start the ${model.label} install.`,
          );
        } else if (model.row.state === "updateFailed") {
          void run(
            "tryAgain",
            () =>
              updateProvider({
                environmentId,
                input: { provider: snapshot.driver, instanceId: instanceId as never },
              }),
            `Couldn't check ${model.label}.`,
          );
        } else {
          void run(
            "tryAgain",
            () => recheck({ environmentId, input: { instanceId: instanceId as never } }),
            `Couldn't check ${model.label}.`,
          );
        }
        return;
      case "testAgain":
        void run(
          "testAgain",
          () =>
            model.row.state === "testFailed"
              ? runTest({ environmentId, input: { instanceId: instanceId as never } })
              : recheck({ environmentId, input: { instanceId: instanceId as never } }),
          `Couldn't test ${model.label}.`,
        );
        return;
    }
  };

  const saveKey = async () => {
    if (keyField === undefined || keyDraft.trim().length === 0) return;
    setBusy("saveKey");
    setError(null);
    const writeFailure = await writeInstance({
      driver: snapshot.driver,
      enabled: true,
      config: instance?.config ?? {},
      environment: withProviderApiKey(environment, keyField, keyDraft),
    });
    clearKeyDraft();
    setKeyOpen(false);
    if (writeFailure === null) setNotice("Key saved. It is never shown again.");
    else setError(writeFailure);
    setBusy(null);
  };

  const removeKey = async () => {
    if (keyField === undefined) return;
    setBusy("removeKey");
    setError(null);
    const failure = await writeInstance({
      driver: snapshot.driver,
      enabled: instance?.enabled ?? snapshot.enabled,
      config: instance?.config ?? {},
      environment: withoutProviderApiKey(environment, keyField),
    });
    if (failure === null) setNotice("Key removed.");
    else setError(failure);
    setBusy(null);
  };

  const remap = async (nextModel: string) => {
    setBusy("remap");
    setError(null);
    const affected = (bots.data?.bots ?? []).filter(
      (bot) => bot.modelSelection.instanceId === instanceId,
    );
    for (const bot of affected) {
      const result = await updateBot({
        environmentId,
        input: {
          botId: bot.botId,
          modelSelection: { instanceId: instanceId as never, model: nextModel },
        },
      });
      const failure = commandFailureMessage(result, `Couldn't switch ${bot.name}.`);
      if (failure !== null) {
        setError(failure);
        setBusy(null);
        return;
      }
    }
    setSheet(null);
    setNotice(
      `${affected.length === 1 ? "The bot switched" : "The bots switched"} to the new model.`,
    );
    setBusy(null);
  };

  const toggleEnabled = async (enabled: boolean) => {
    const failure = await writeInstance({
      driver: snapshot.driver,
      enabled,
      config: instance?.config ?? {},
      environment,
    });
    if (failure !== null) setError(failure);
  };

  const remove = async () => {
    const failure = await run(
      "remove",
      () => removeInstall({ environmentId, input: { instanceId: instanceId as never } }),
      `Couldn't remove ${model.label}.`,
    );
    if (failure === null) onBack();
  };

  const signOut = async () => {
    const failure = await run(
      "signOut",
      () => logoutAuth({ environmentId, input: { instanceId: instanceId as never } }),
      `Couldn't sign out of ${model.label}.`,
    );
    if (failure === null) setSheet(null);
  };

  const shownModels = modelsShown(snapshot.models, expanded);
  const users = botsUsingProvider(instanceId, bots.data?.bots ?? []);

  return (
    <SettingsPage title={model.label} onBack={onBack}>
      <View style={styles.hero}>
        <View style={[styles.tile, model.tone === "error" ? styles.tileError : null]}>
          <Text style={styles.tileLetter} maxFontSizeMultiplier={1.3}>
            {model.label.slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <View style={styles.heroText}>
          <Text style={styles.heroTitle} maxFontSizeMultiplier={1.4}>
            {model.label}
          </Text>
          <Text style={styles.heroSub} maxFontSizeMultiplier={1.4}>
            {providerPublisherLine(snapshot)}
          </Text>
        </View>
      </View>

      <Section label="Status">
        <Row
          title={model.row.statusText}
          hint={model.row.detail ?? undefined}
          right={
            model.row.busy || busy !== null ? (
              <ActivityIndicator color={tokens.textSecondary} />
            ) : model.row.action === null ? undefined : (
              <TextButton label={model.row.action.label} onPress={act} />
            )
          }
        />
        {model.row.progress === null ? null : (
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                {
                  width:
                    model.row.progress.fraction === null
                      ? "40%"
                      : `${Math.round(model.row.progress.fraction * 100)}%`,
                },
              ]}
            />
          </View>
        )}
        {notice === null ? null : <Notice tone="success">{notice}</Notice>}
        {error === null ? null : <Notice tone="danger">{error}</Notice>}
      </Section>

      {model.installed ? null : (
        <Section label="Before installing">
          <Row title="What it costs" hint={providerPriceLine(snapshot)} />
          <Row
            title="Sign in"
            value={
              snapshot.setup?.canAuthenticate === true
                ? "Browser or laptop"
                : (keyField?.label ?? "Shown after install")
            }
          />
          <Row title="Version" value={snapshot.version ?? "Not reported"} />
          <Row title="Licence" value={snapshot.license ?? "Not listed"} last />
          {snapshot.setup?.canInstall === true ? (
            <PrimaryButton
              label={`Install ${model.label}`}
              onPress={() => setSheet("install")}
              busy={busy === "install"}
            />
          ) : (
            <SectionNote>
              Install it on your computer. {model.label} can't be installed from the phone yet.
            </SectionNote>
          )}
        </Section>
      )}

      {keyField === undefined ? null : (
        <Section label="Account">
          <Row
            title={keyField.label}
            hint={savedKey ? "Saved · never shown again" : keyField.emptyDescription}
            right={
              savedKey ? (
                <View style={styles.rowButtons}>
                  <TextButton label="Replace" onPress={() => setKeyOpen(true)} />
                  <TextButton label="Remove" onPress={() => void removeKey()} destructive />
                </View>
              ) : (
                <TextButton label="Add key" onPress={() => setKeyOpen(true)} />
              )
            }
            last={!keyOpen}
          />
          {keyOpen ? (
            <View style={styles.keyForm}>
              <Field
                label={keyField.label}
                value={keyDraft}
                onChangeText={setKeyDraft}
                placeholder={keyField.placeholder}
                secure
                autoCapitalize="none"
                autoComplete="off"
                help="Saved on your computer and never shown in a chat."
              />
              <TextButton
                label={keyField.keysUrlLabel}
                onPress={() => void Linking.openURL(keyField.keysUrl)}
              />
              <View style={styles.rowButtons}>
                <TextButton
                  label="Cancel"
                  onPress={() => {
                    clearKeyDraft();
                    setKeyOpen(false);
                  }}
                />
                <PrimaryButton
                  label={busy === "saveKey" ? "Saving…" : "Save key"}
                  onPress={() => void saveKey()}
                  busy={busy === "saveKey"}
                  disabled={keyDraft.trim().length === 0}
                />
              </View>
            </View>
          ) : null}
          {snapshot.auth.status === "authenticated" ? (
            <Row
              title={`${keyField.displayName} account`}
              hint={`Signed in · ${snapshot.auth.label ?? snapshot.auth.email ?? model.label}`}
              right={
                <TextButton label="Sign out" onPress={() => setSheet("signOut")} destructive />
              }
              last
            />
          ) : null}
        </Section>
      )}

      {model.installed && model.canTest ? (
        <Section label="Test">
          <Row
            title="Send a test message"
            hint="Asks for one word and checks the answer"
            right={
              <TextButton
                label="Test"
                onPress={() => {
                  void run(
                    "test",
                    () => runTest({ environmentId, input: { instanceId: instanceId as never } }),
                    `Couldn't test ${model.label}.`,
                  );
                }}
              />
            }
            last
          />
        </Section>
      ) : null}

      <Section label="Use">
        <ToggleRow
          title="Use for bots"
          hint={
            snapshot.models.length > 0
              ? "Its models show in the bot form"
              : "No models yet, so bots can't pick it"
          }
          value={snapshot.enabled}
          onValueChange={(enabled) => {
            if (!enabled && users.length > 0) setSheet("turnOff");
            else void toggleEnabled(enabled);
          }}
        />
        <ToggleRow
          title="Show usage"
          hint="Its limits on the Bots page"
          value={snapshot.showUsage !== false}
          onValueChange={(visible) => {
            void setProfile({
              environmentId,
              input: { usageVisibility: { instanceId: instanceId as never, visible } },
            }).then((result) => {
              const failure = commandFailureMessage(
                result,
                `Couldn't save ${model.label}'s usage setting.`,
              );
              if (failure !== null) setError(failure);
            });
          }}
          last
        />
      </Section>

      {snapshot.models.length === 0 ? null : (
        <Section label={`Models · ${snapshot.models.length}`}>
          {shownModels.map((entry, index) => (
            <Row
              key={entry.slug}
              title={entry.name}
              hint={index === 0 ? "Default model" : undefined}
              last={index === shownModels.length - 1 && snapshot.models.length <= 3}
            />
          ))}
          {snapshot.models.length > 3 ? (
            <TextButton
              label={expanded ? "Show fewer" : `Show all ${snapshot.models.length}`}
              onPress={() => setExpanded(!expanded)}
            />
          ) : null}
        </Section>
      )}

      <Section label="Version">
        <Row title={snapshot.version ?? "Not reported"} hint={versionLine(snapshot, new Date())} />
        <Row title="Source" value={providerSourceLine(snapshot)} last />
      </Section>

      {snapshot.setup?.canRemove === true ? (
        <Section label="Remove">
          <Row
            title={`Remove ${model.label}`}
            hint="Deletes it from your laptop. Bots that use it stop until you pick another model."
            onPress={() => setSheet("remove")}
            last
          />
        </Section>
      ) : null}

      <InstallConfirmSheet
        visible={sheet === "install"}
        snapshot={snapshot}
        facts={facts.data}
        busy={busy === "install"}
        onClose={() => setSheet(null)}
        onInstall={() => void enableThenInstall()}
      />
      <ProviderConfirmSheet
        visible={sheet === "remove"}
        title={`Remove ${model.label}?`}
        subtitle="From your laptop"
        body={
          users.length > 0
            ? `${users.join(" and ")} ${users.length === 1 ? "uses" : "use"} it and can't reply. Your sign-in for ${model.label} is kept.`
            : `Your sign-in for ${model.label} is kept; remove it with Sign out first if you want it gone.`
        }
        confirmLabel="Remove"
        busy={busy === "remove"}
        onClose={() => setSheet(null)}
        onConfirm={() => void remove()}
      />
      <ProviderConfirmSheet
        visible={sheet === "turnOff"}
        title={`Turn off ${model.label}?`}
        subtitle="Bots can't use it while it's off"
        body={`${users.join(" and ")} ${users.length === 1 ? "uses" : "use"} it and can't reply until you turn it back on or give ${users.length === 1 ? "it" : "them"} another model.`}
        confirmLabel="Turn off"
        busy={false}
        onClose={() => setSheet(null)}
        onConfirm={() => {
          setSheet(null);
          void toggleEnabled(false);
        }}
      />
      <ProviderConfirmSheet
        visible={sheet === "signOut"}
        title={`Sign out of ${model.label}?`}
        subtitle="On your laptop"
        body="This stops its running chats. Chat history is kept, and you can sign in again any time."
        confirmLabel="Sign out"
        busy={busy === "signOut"}
        onClose={() => setSheet(null)}
        onConfirm={() => void signOut()}
      />
      <RemapSheet
        visible={sheet === "remap"}
        label={model.label}
        models={snapshot.models}
        busy={busy === "remap"}
        onClose={() => setSheet(null)}
        onPick={(next) => void remap(next)}
      />
    </SettingsPage>
  );
}

function providerPublisherLine(snapshot: ServerProvider): string {
  const publisher = snapshot.publisher ?? "Built into hbots";
  if (snapshot.openSource === null || snapshot.openSource === undefined) return publisher;
  return `${publisher} · ${snapshot.openSource ? "Open source" : "Closed source"}`;
}

const styles = StyleSheet.create({
  hero: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 8 },
  tile: {
    width: 64,
    height: 64,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.fillMuted,
  },
  tileError: { borderWidth: 1, borderColor: tokens.dangerBorder },
  tileLetter: { color: tokens.text, fontSize: 26, fontWeight: "600" },
  heroText: { flex: 1, gap: 2 },
  heroTitle: { color: tokens.text, fontSize: 22, fontWeight: "600" },
  heroSub: { color: tokens.textSecondary, fontSize: 13 },
  rowButtons: { flexDirection: "row", alignItems: "center" },
  keyForm: { paddingBottom: 8 },
  progressTrack: {
    height: 4,
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: 2,
    backgroundColor: tokens.track,
    overflow: "hidden",
  },
  progressFill: { height: 4, backgroundColor: tokens.primary },
});
