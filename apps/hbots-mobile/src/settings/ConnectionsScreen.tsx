import type {
  EnvironmentId,
  PersonalConnection,
  PersonalConnectionImportResult,
  PersonalConnectionVendorId,
} from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import {
  connectionActionLabel,
  connectionActions,
  connectionRows,
  dailySendCap,
  describeConnection,
  describeImportSource,
  disconnectWarning,
  fieldLabel,
  friendlyTokenFailure,
  validateTokenDraft,
  vendorInfo,
  type ConnectionAction,
} from "@hbots/personal-client/settings/connectionsModel";
import * as Redacted from "effect/Redacted";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useSecretDrafts } from "../platform/useSecretDraft";
import { useSecureScreen } from "../platform/secureScreen";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { Field, PrimaryButton, TextButton } from "./SettingsUi";

export function ConnectionsScreen({
  native,
  onBack,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId as EnvironmentId;
  useSecureScreen(true);
  const list = native.connections.usePersonalConnections(environmentId);
  const runConnect = native.client.useAtomCommand(native.connections.personalConnectionConnect, {
    reportFailure: false,
  });
  const runValidate = native.client.useAtomCommand(native.connections.personalConnectionValidate, {
    reportFailure: false,
  });
  const runDisable = native.client.useAtomCommand(native.connections.personalConnectionDisable, {
    reportFailure: false,
  });
  const runReconnect = native.client.useAtomCommand(
    native.connections.personalConnectionReconnect,
    { reportFailure: false },
  );
  const runDisconnect = native.client.useAtomCommand(
    native.connections.personalConnectionDisconnect,
    { reportFailure: false },
  );
  const runRotate = native.client.useAtomCommand(native.connections.personalConnectionRotate, {
    reportFailure: false,
  });
  const runBrowser = native.client.useAtomCommand(
    native.connections.personalConnectionBrowserConnect,
    { reportFailure: false },
  );
  const runSettings = native.client.useAtomCommand(
    native.connections.personalConnectionSetSettings,
    { reportFailure: false },
  );
  const runProbe = native.client.useAtomCommand(native.connections.personalConnectionImportProbe, {
    reportFailure: false,
  });
  const runAdopt = native.client.useAtomCommand(native.connections.personalConnectionImportAdopt, {
    reportFailure: false,
  });
  const [pasting, setPasting] = useState<PersonalConnectionVendorId | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<PersonalConnectionImportResult | null>(null);

  const connections = list.data?.connections ?? [];
  const rows = connectionRows(connections);

  const act = async (
    action: ConnectionAction,
    vendorId: PersonalConnectionVendorId,
    connection: PersonalConnection | null,
  ) => {
    if (action === "connect" || action === "reconnect") {
      if (vendorInfo(vendorId).authKind === "browser-session") {
        setBusy(true);
        const result = await runBrowser({ environmentId, input: { vendorId } });
        const failure =
          result === null
            ? "Not connected to your computer."
            : commandFailureMessage(
                result,
                `${vendorInfo(vendorId).displayName} could not be opened in the shared browser.`,
              );
        if (failure === null && result !== null && result._tag === "Success") {
          setNotice(result.value.instruction);
        } else {
          setError(failure);
        }
        setBusy(false);
        return;
      }
      setPasting(vendorId);
      setError(null);
      return;
    }
    if (action === "disconnect") {
      const vendor = vendorInfo(vendorId);
      Alert.alert(
        `Remove ${vendor.displayName}?`,
        disconnectWarning(vendorId).split("\n")[1] ?? "",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Disconnect",
            style: "destructive",
            onPress: () => {
              if (connection === null) return;
              void runDisconnect({
                environmentId,
                input: { connectionId: connection.connectionId },
              }).then((result) => {
                const failure = commandFailureMessage(
                  result,
                  `${vendor.displayName} could not be changed.`,
                );
                if (failure !== null) setError(failure);
                else setNotice(`${vendor.displayName} removed.`);
              });
            },
          },
        ],
      );
      return;
    }
    if (connection === null) return;
    const command =
      action === "validate" ? runValidate : action === "disable" ? runDisable : runReconnect;
    setBusy(true);
    const result = await command({
      environmentId,
      input: { connectionId: connection.connectionId },
    });
    const failure =
      result === null
        ? "Not connected to your computer."
        : commandFailureMessage(
            result,
            `${vendorInfo(vendorId).displayName} could not be changed.`,
          );
    if (failure === null && result !== null && result._tag === "Success" && action === "validate") {
      const value = result.value as { readonly problem?: string | null };
      setNotice(value.problem ?? `${vendorInfo(vendorId).displayName} is working.`);
    } else if (failure !== null) {
      setError(failure);
    }
    setBusy(false);
  };

  const probe = async () => {
    setBusy(true);
    setError(null);
    const result = await runProbe({ environmentId, input: {} });
    if (result === null || result._tag !== "Success") {
      setError("This machine could not be checked.");
    } else {
      setImportResult(result.value);
    }
    setBusy(false);
  };

  const adopt = async (candidateId: string) => {
    setBusy(true);
    const result = await runAdopt({ environmentId, input: { candidateId: candidateId as never } });
    const failure =
      result === null
        ? "Not connected to your computer."
        : commandFailureMessage(
            result,
            "That login could not be used. It may not have the access hbots needs.",
          );
    if (failure !== null) setError(failure);
    else {
      setNotice("Login imported.");
      setImportResult(null);
      setImportOpen(false);
    }
    setBusy(false);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader
        title="Connections"
        onBack={onBack}
        right={
          <TextButton
            label="Import"
            onPress={() => {
              setImportOpen(!importOpen);
              if (!importOpen) setImportResult(null);
            }}
          />
        }
      />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.intro} maxFontSizeMultiplier={1.5}>
          Accounts your bots can act on. Every bot can use every connection you turn on, the same
          way saved logins work. hbots holds the token and does the work itself, so a bot never sees
          it, and anything that changes your account or ships something asks you first.
        </Text>

        {importOpen ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle} maxFontSizeMultiplier={1.4}>
              Import from this machine
            </Text>
            <Text style={styles.meta} maxFontSizeMultiplier={1.5}>
              hbots can use the GitHub and Vercel logins the command-line tools on this computer
              already hold. It checks them with the provider before using them, and never shows you
              or a bot the value.
            </Text>
            <View style={styles.rowButtons}>
              <TextButton
                label={busy ? "Checking…" : "Check this computer"}
                onPress={() => void probe()}
              />
              <TextButton label="Close" onPress={() => setImportOpen(false)} />
            </View>
            {(importResult?.candidates ?? []).map((candidate) => (
              <View key={candidate.candidateId} style={styles.importRow}>
                <Text style={styles.optionTitle} maxFontSizeMultiplier={1.4}>
                  {candidate.sourceLabel}
                  {candidate.identifier === null ? "" : ` - ${candidate.identifier}`}
                </Text>
                <TextButton label="Use this" onPress={() => void adopt(candidate.candidateId)} />
              </View>
            ))}
            {(importResult?.sources ?? [])
              .filter((source) => source.state !== "found")
              .map((source) => (
                <Text key={source.sourceId} style={styles.meta} maxFontSizeMultiplier={1.4}>
                  {describeImportSource(source).text}
                </Text>
              ))}
          </View>
        ) : null}

        {error === null ? null : <Text style={styles.error}>{error}</Text>}
        {notice === null ? null : <Text style={styles.notice}>{notice}</Text>}
        {list.data === null ? <Text style={styles.meta}>{list.error ?? "Loading…"}</Text> : null}

        {rows.map((row) => {
          const vendor = row.vendor;
          const described = row.connection === null ? null : describeConnection(row.connection);
          const actions = connectionActions(row.connection);
          return (
            <View key={vendor.vendorId} style={styles.card}>
              <Text style={styles.cardTitle} maxFontSizeMultiplier={1.4}>
                {vendor.displayName}
              </Text>
              <Text style={styles.headline} maxFontSizeMultiplier={1.4}>
                {described?.headline ?? "Not connected"}
              </Text>
              <Text style={styles.meta} maxFontSizeMultiplier={1.5}>
                {described?.detail ?? vendor.purpose}
              </Text>
              {row.connection !== null && row.connection.verifiedCapabilities.length > 0 ? (
                <Text style={styles.meta} maxFontSizeMultiplier={1.4}>
                  Can: {row.connection.verifiedCapabilities.join(", ")}
                </Text>
              ) : null}
              {pasting === vendor.vendorId ? null : (
                <View style={styles.actions}>
                  {actions.map((action) => (
                    <TextButton
                      key={action}
                      label={connectionActionLabel(action, vendor.vendorId)}
                      onPress={() => void act(action, vendor.vendorId, row.connection)}
                      destructive={action === "disconnect"}
                      disabled={busy}
                    />
                  ))}
                </View>
              )}
              {vendor.vendorId === "whatsapp" && row.connection !== null ? (
                <WhatsAppCap
                  connection={row.connection}
                  busy={busy}
                  onSave={async (cap) => {
                    setBusy(true);
                    const result = await runSettings({
                      environmentId,
                      input: {
                        connectionId: row.connection!.connectionId,
                        settings: { whatsappDailySendCap: cap },
                      },
                    });
                    const failure = commandFailureMessage(
                      result,
                      "The daily limit could not be changed.",
                    );
                    if (failure !== null) setError(failure);
                    else setNotice("Daily limit saved.");
                    setBusy(false);
                  }}
                />
              ) : null}
              {pasting === vendor.vendorId && row.connection === null ? (
                <TokenForm
                  vendorId={vendor.vendorId}
                  heading={`Connect ${vendor.displayName}`}
                  busy={busy}
                  onCancel={() => setPasting(null)}
                  onSubmit={async (fields) => {
                    setBusy(true);
                    const credentials = Object.fromEntries(
                      Object.entries(fields).map(([key, fieldValue]) => [
                        key,
                        Redacted.make(fieldValue),
                      ]),
                    );
                    const result = await runConnect({
                      environmentId,
                      input: { vendorId: vendor.vendorId, credentials },
                    });
                    setBusy(false);
                    if (result === null || result._tag !== "Success") {
                      const failure =
                        result === null
                          ? "Not connected to your computer."
                          : commandFailureMessage(
                              result,
                              `${vendor.displayName} could not be connected.`,
                            );
                      setError(friendlyTokenFailure(vendor.displayName, failure ?? ""));
                      return false;
                    }
                    setPasting(null);
                    setNotice(`${vendor.displayName} connected.`);
                    return true;
                  }}
                />
              ) : null}
              {pasting === vendor.vendorId && row.connection !== null ? (
                <TokenForm
                  vendorId={vendor.vendorId}
                  heading={`New ${vendor.displayName} token`}
                  busy={busy}
                  onCancel={() => setPasting(null)}
                  onSubmit={async (fields) => {
                    setBusy(true);
                    const credentials = Object.fromEntries(
                      Object.entries(fields).map(([key, fieldValue]) => [
                        key,
                        Redacted.make(fieldValue),
                      ]),
                    );
                    const result = await runRotate({
                      environmentId,
                      input: { connectionId: row.connection!.connectionId, credentials },
                    });
                    setBusy(false);
                    if (result === null || result._tag !== "Success") {
                      const failure =
                        result === null
                          ? "Not connected to your computer."
                          : commandFailureMessage(
                              result,
                              `${vendor.displayName} could not be connected.`,
                            );
                      setError(friendlyTokenFailure(vendor.displayName, failure ?? ""));
                      return false;
                    }
                    setPasting(null);
                    setNotice(`${vendor.displayName} updated.`);
                    return true;
                  }}
                />
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function TokenForm({
  vendorId,
  heading,
  busy,
  onCancel,
  onSubmit,
}: {
  readonly vendorId: PersonalConnectionVendorId;
  readonly heading: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (fields: Readonly<Record<string, string>>) => Promise<boolean>;
}) {
  const vendor = vendorInfo(vendorId);
  const [draft, setDraft, clear] = useSecretDrafts();
  const [error, setError] = useState<string | null>(null);
  const fields = vendor.requiredCredentialFields;
  return (
    <View style={styles.tokenForm}>
      <Text style={styles.cardTitle} maxFontSizeMultiplier={1.4}>
        {heading}
      </Text>
      <Text style={styles.meta} maxFontSizeMultiplier={1.5}>
        {vendor.requiredScopes.length === 0
          ? `Create a token on ${vendor.displayName} and paste it here.`
          : `Create a token with ${vendor.requiredScopes.join(" and ")} ticked, then paste it here. hbots checks it against ${vendor.displayName} before saving and tells you if a box is missing.`}
      </Text>
      {fields.map((field) => (
        <Field
          key={field}
          label={fieldLabel(field)}
          value={draft[field] ?? ""}
          onChangeText={(next) => setDraft(field, next)}
          secure
          autoCapitalize="none"
          autoComplete="off"
        />
      ))}
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
      <View style={styles.rowButtons}>
        <TextButton
          label="Cancel"
          onPress={() => {
            clear();
            onCancel();
          }}
        />
        <PrimaryButton
          label={busy ? "Checking…" : "Save and check"}
          onPress={() => {
            const problem = Object.values(validateTokenDraft(vendor.vendorId, draft))[0];
            if (problem !== undefined) {
              setError(problem);
              return;
            }
            void onSubmit(draft).then((ok) => {
              if (ok) clear();
            });
          }}
          busy={busy}
        />
      </View>
    </View>
  );
}

function WhatsAppCap({
  connection,
  busy,
  onSave,
}: {
  readonly connection: PersonalConnection;
  readonly busy: boolean;
  readonly onSave: (cap: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(dailySendCap(connection)));
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={styles.cap}>
      <Text style={styles.optionTitle} maxFontSizeMultiplier={1.4}>
        Messages a day
      </Text>
      <View style={styles.capRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          keyboardType="numeric"
          accessibilityLabel="Messages a day"
          style={styles.capInput}
        />
        <TextButton
          label={busy ? "Saving…" : "Save"}
          onPress={() => {
            const cap = Number(draft);
            if (!Number.isInteger(cap) || cap < 1 || cap > 100) {
              setError("Choose a number between 1 and 100.");
              return;
            }
            setError(null);
            void onSave(cap);
          }}
        />
      </View>
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
      <Text style={styles.meta} maxFontSizeMultiplier={1.4}>
        hbots refuses to send past this rather than saving it for tomorrow, and leaves a gap between
        messages so your account does not look automated.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { padding: 16, gap: 12 },
  intro: { color: tokens.textSecondary, fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    padding: 14,
    gap: 6,
  },
  cardTitle: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  headline: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  meta: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17 },
  error: { color: tokens.danger, fontSize: 13, lineHeight: 18 },
  notice: { color: tokens.working, fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 4, justifyContent: "flex-end" },
  rowButtons: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center" },
  importRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  tokenForm: {
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingTop: 10,
  },
  cap: {
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingTop: 8,
  },
  capRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  capInput: {
    width: 80,
    minHeight: 40,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
    color: tokens.text,
    fontSize: 15,
    textAlign: "center",
  },
  optionTitle: { color: tokens.text, fontSize: 14, fontWeight: "500" },
});
