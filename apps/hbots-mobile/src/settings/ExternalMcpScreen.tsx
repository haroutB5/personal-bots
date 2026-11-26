import {
  botTeam,
  isGroupOnlyBot,
  personalBotTeamLabel,
  personalBotTeams,
  type EnvironmentId,
  type PersonalExternalMcpScope,
  type PersonalExternalMcpServer,
} from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import {
  applyExecutorPreset,
  draftFromExternalMcpServer,
  emptyExternalMcpDraft,
  EXECUTOR_LOCAL_PRESET,
  EXTERNAL_MCP_SCOPES,
  formatExternalMcpScopeBadge,
  formatExternalMcpTestResult,
  formatExternalMcpTokenStatus,
  hasExternalMcpDraftErrors,
  slugFromDisplayName,
  validateExternalMcpDraft,
  type ExternalMcpDraft,
  type ExternalMcpDraftErrors,
  type ExternalMcpTestSummary,
} from "@hbots/personal-client/settings/externalMcpModel";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useSecureScreen } from "../platform/secureScreen";
import { useSecretDraft } from "../platform/useSecretDraft";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { Field, PrimaryButton, TextButton } from "./SettingsUi";

type FormState =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly server: PersonalExternalMcpServer };

export function ExternalMcpScreen({
  native,
  onBack,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId as EnvironmentId;
  const list = native.externalMcp.usePersonalExternalMcpServers(environmentId);
  const bots = native.bots.usePersonalBotsList(environmentId);
  const profile = native.bots.usePersonalProfile(environmentId);

  const runCreate = native.client.useAtomCommand(native.externalMcp.personalExternalMcpCreate, {
    reportFailure: false,
  });
  const runUpdate = native.client.useAtomCommand(native.externalMcp.personalExternalMcpUpdate, {
    reportFailure: false,
  });
  const runDelete = native.client.useAtomCommand(native.externalMcp.personalExternalMcpDelete, {
    reportFailure: false,
  });
  const runTest = native.client.useAtomCommand(
    native.externalMcp.personalExternalMcpTestConnection,
    { reportFailure: false },
  );

  const [form, setForm] = useState<FormState | null>(null);
  const [draft, setDraft] = useState<ExternalMcpDraft>(emptyExternalMcpDraft);
  const [slugTouched, setSlugTouched] = useState(false);
  const [bearerToken, setBearerToken, clearBearerToken] = useSecretDraft();
  const [clearSavedToken, setClearSavedToken] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ExternalMcpDraftErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Readonly<Record<string, ExternalMcpTestSummary>>>(
    {},
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useSecureScreen(form !== null && bearerToken.length > 0);

  const servers = list.data?.servers ?? [];

  const liveBots = useMemo(
    () => (bots.data?.bots ?? []).filter((bot) => !isGroupOnlyBot(bot)),
    [bots.data?.bots],
  );

  const liveTeams = useMemo(
    () =>
      personalBotTeams([
        ...(profile.data?.customTeams ?? []),
        ...liveBots.map((bot) => botTeam(bot)),
      ]),
    [liveBots, profile.data?.customTeams],
  );

  const botNameById = useMemo(() => {
    const map = new Map((bots.data?.bots ?? []).map((bot) => [String(bot.botId), bot.name]));
    return (botId: string) => map.get(botId);
  }, [bots.data?.bots]);

  const openAdd = (preset = false) => {
    const next = preset ? applyExecutorPreset(emptyExternalMcpDraft()) : emptyExternalMcpDraft();
    setForm({ mode: "add" });
    setDraft(next);
    setSlugTouched(preset);
    clearBearerToken();
    setClearSavedToken(false);
    setFieldErrors({});
    setFormError(null);
    setError(null);
    setNotice(null);
  };

  const openEdit = (server: PersonalExternalMcpServer) => {
    setForm({ mode: "edit", server });
    setDraft(draftFromExternalMcpServer(server));
    setSlugTouched(true);
    clearBearerToken();
    setClearSavedToken(false);
    setFieldErrors({});
    setFormError(null);
    setError(null);
    setNotice(null);
  };

  const closeForm = () => {
    clearBearerToken();
    setForm(null);
    setFieldErrors({});
    setFormError(null);
    setClearSavedToken(false);
  };

  const selectScope = (scope: PersonalExternalMcpScope) => {
    let nextScopeId: string | null = null;
    if (scope === "team") {
      nextScopeId =
        draft.scope === "team" && draft.scopeId !== null ? draft.scopeId : (liveTeams[0] ?? null);
    } else if (scope === "bot") {
      nextScopeId =
        draft.scope === "bot" && draft.scopeId !== null
          ? draft.scopeId
          : liveBots[0] !== undefined
            ? String(liveBots[0].botId)
            : null;
    }
    setDraft((current) => ({ ...current, scope, scopeId: nextScopeId }));
    setFieldErrors((current) => ({ ...current, scopeId: undefined }));
  };

  const submitForm = async () => {
    if (form === null) return;
    const errors = validateExternalMcpDraft(draft);
    if (hasExternalMcpDraftErrors(errors)) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setFormError(null);
    setBusy(true);

    const trimmedScopeId = draft.scope === "shared" ? null : (draft.scopeId?.trim() ?? null);
    const trimmedToken = bearerToken.trim();

    if (form.mode === "add") {
      const result = await runCreate({
        environmentId,
        input: {
          displayName: draft.displayName.trim(),
          slug: draft.slug.trim(),
          url: draft.url.trim(),
          scope: draft.scope,
          scopeId: trimmedScopeId,
          enabled: true,
          ...(trimmedToken.length > 0 ? { bearerToken: trimmedToken } : {}),
        },
      });
      setBusy(false);
      const failure =
        result === null
          ? "Not connected to your computer."
          : commandFailureMessage(result, "Could not add this MCP server.");
      if (failure !== null) {
        setFormError(failure);
        return;
      }
      closeForm();
      setNotice("MCP server added.");
      return;
    }

    const tokenPatch =
      trimmedToken.length > 0
        ? { bearerToken: trimmedToken }
        : clearSavedToken
          ? { bearerToken: null }
          : {};
    const result = await runUpdate({
      environmentId,
      input: {
        serverId: form.server.serverId,
        displayName: draft.displayName.trim(),
        slug: draft.slug.trim(),
        url: draft.url.trim(),
        scope: draft.scope,
        scopeId: trimmedScopeId,
        ...tokenPatch,
      },
    });
    setBusy(false);
    const failure =
      result === null
        ? "Not connected to your computer."
        : commandFailureMessage(result, "Could not save changes.");
    if (failure !== null) {
      setFormError(failure);
      return;
    }
    closeForm();
    setNotice("MCP server updated.");
  };

  const toggleEnabled = async (server: PersonalExternalMcpServer, enabled: boolean) => {
    setBusy(true);
    setError(null);
    const result = await runUpdate({
      environmentId,
      input: { serverId: server.serverId, enabled },
    });
    const failure =
      result === null
        ? "Not connected to your computer."
        : commandFailureMessage(result, `Could not update ${server.displayName}.`);
    if (failure !== null) {
      setError(failure);
    }
    setBusy(false);
  };

  const testServer = async (server: PersonalExternalMcpServer) => {
    const id = String(server.serverId);
    setTestingId(id);
    setError(null);
    const result = await runTest({
      environmentId,
      input: { serverId: server.serverId },
    });
    setTestingId(null);
    if (result === null) {
      setTestResults((current) => ({
        ...current,
        [id]: { ok: false, text: "Not connected to your computer." },
      }));
      return;
    }
    if (result._tag !== "Success") {
      setTestResults((current) => ({
        ...current,
        [id]: {
          ok: false,
          text:
            commandFailureMessage(result, "Connection test failed.") ?? "Connection test failed.",
        },
      }));
      return;
    }
    setTestResults((current) => ({
      ...current,
      [id]: formatExternalMcpTestResult(result.value),
    }));
  };

  const confirmDelete = (server: PersonalExternalMcpServer) => {
    Alert.alert(
      `Remove ${server.displayName}?`,
      "Bots will no longer be able to use tools from this MCP server, and any saved Bearer token will be deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            setBusy(true);
            setError(null);
            void runDelete({
              environmentId,
              input: { serverId: server.serverId },
            }).then((result) => {
              setBusy(false);
              const failure =
                result === null
                  ? "Not connected to your computer."
                  : commandFailureMessage(result, `Could not remove ${server.displayName}.`);
              if (failure !== null) {
                setError(failure);
              } else {
                if (form?.mode === "edit" && form.server.serverId === server.serverId) {
                  closeForm();
                }
                setNotice(`${server.displayName} removed.`);
              }
            });
          },
        },
      ],
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader
        title="External MCP servers"
        onBack={onBack}
        right={
          <TextButton label="Add server" onPress={() => openAdd(false)} disabled={form !== null} />
        }
      />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.intro} maxFontSizeMultiplier={1.5}>
          Connect self-hosted Executor or remote Streamable HTTP MCP servers. hbots proxies calls
          through your computer, holds any Bearer token on the server, and blocks calls while a
          sensitive site is open in the shared browser.
        </Text>

        {list.error === null ? null : <Text style={styles.error}>{list.error}</Text>}
        {error === null ? null : <Text style={styles.error}>{error}</Text>}
        {notice === null ? null : <Text style={styles.notice}>{notice}</Text>}

        {form !== null ? (
          <View style={styles.formCard}>
            <Text style={styles.formTitle} maxFontSizeMultiplier={1.4}>
              {form.mode === "add" ? "Add MCP server" : `Edit ${form.server.displayName}`}
            </Text>

            <View style={styles.presetRow}>
              <TextButton
                label="Use local Executor preset"
                onPress={() => {
                  setDraft((current) => applyExecutorPreset(current));
                  setSlugTouched(true);
                  setFieldErrors({});
                }}
                disabled={busy}
              />
            </View>

            <Field
              label="Display name"
              value={draft.displayName}
              onChangeText={(next) => {
                setDraft((current) => ({
                  ...current,
                  displayName: next,
                  ...(slugTouched ? {} : { slug: slugFromDisplayName(next) }),
                }));
                if (fieldErrors.displayName !== undefined) {
                  setFieldErrors((current) => ({ ...current, displayName: undefined }));
                }
              }}
              placeholder="Executor"
              autoComplete="off"
              error={fieldErrors.displayName}
            />

            <Field
              label="Slug"
              value={draft.slug}
              onChangeText={(next) => {
                setSlugTouched(true);
                setDraft((current) => ({ ...current, slug: next.toLowerCase() }));
                if (fieldErrors.slug !== undefined) {
                  setFieldErrors((current) => ({ ...current, slug: undefined }));
                }
              }}
              placeholder="executor"
              autoCapitalize="none"
              autoComplete="off"
              help="Lowercase letters, numbers, hyphens or underscores. Exposed to providers as ext-<slug>."
              error={fieldErrors.slug}
            />

            <Field
              label="Server URL"
              value={draft.url}
              onChangeText={(next) => {
                setDraft((current) => ({ ...current, url: next }));
                if (fieldErrors.url !== undefined) {
                  setFieldErrors((current) => ({ ...current, url: undefined }));
                }
              }}
              placeholder={EXECUTOR_LOCAL_PRESET.url}
              keyboardType="url"
              autoCapitalize="none"
              autoComplete="off"
              help="Use https:// for remote servers, or http://127.0.0.1 / localhost / [::1] for local servers."
              error={fieldErrors.url}
            />

            <View style={styles.scopeSection}>
              <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.4}>
                Who can use this server
              </Text>
              <View style={styles.chips}>
                {EXTERNAL_MCP_SCOPES.map((option) => {
                  const selected = draft.scope === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => selectScope(option.value)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      style={[styles.chip, selected ? styles.chipSelected : null]}
                    >
                      <Text
                        style={[styles.chipLabel, selected ? styles.chipLabelSelected : null]}
                        maxFontSizeMultiplier={1.3}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.meta} maxFontSizeMultiplier={1.4}>
                {EXTERNAL_MCP_SCOPES.find((option) => option.value === draft.scope)?.hint}
              </Text>

              {draft.scope === "team" ? (
                <View style={styles.scopePicker}>
                  <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.4}>
                    Team
                  </Text>
                  <View style={styles.chips}>
                    {liveTeams.map((team) => {
                      const selected = draft.scopeId === team;
                      return (
                        <Pressable
                          key={team}
                          onPress={() => {
                            setDraft((current) => ({ ...current, scopeId: team }));
                            setFieldErrors((current) => ({ ...current, scopeId: undefined }));
                          }}
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          style={[styles.chip, selected ? styles.chipSelected : null]}
                        >
                          <Text
                            style={[styles.chipLabel, selected ? styles.chipLabelSelected : null]}
                            maxFontSizeMultiplier={1.3}
                          >
                            {personalBotTeamLabel(team)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}

              {draft.scope === "bot" ? (
                <View style={styles.scopePicker}>
                  <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.4}>
                    Bot
                  </Text>
                  {liveBots.length === 0 ? (
                    <Text style={styles.meta} maxFontSizeMultiplier={1.4}>
                      No bots available yet.
                    </Text>
                  ) : (
                    <View style={styles.chips}>
                      {liveBots.map((bot) => {
                        const id = String(bot.botId);
                        const selected = draft.scopeId === id;
                        return (
                          <Pressable
                            key={id}
                            onPress={() => {
                              setDraft((current) => ({ ...current, scopeId: id }));
                              setFieldErrors((current) => ({ ...current, scopeId: undefined }));
                            }}
                            accessibilityRole="radio"
                            accessibilityState={{ selected }}
                            style={[styles.chip, selected ? styles.chipSelected : null]}
                          >
                            <Text
                              style={[styles.chipLabel, selected ? styles.chipLabelSelected : null]}
                              maxFontSizeMultiplier={1.3}
                            >
                              {bot.name}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>
              ) : null}

              {fieldErrors.scopeId === undefined ? null : (
                <Text style={styles.fieldError} accessibilityRole="alert">
                  {fieldErrors.scopeId}
                </Text>
              )}
            </View>

            <Field
              label="Bearer token (optional)"
              value={bearerToken}
              onChangeText={(next) => {
                setBearerToken(next);
                if (next.length > 0 && clearSavedToken) {
                  setClearSavedToken(false);
                }
              }}
              placeholder={
                form.mode === "edit" && form.server.hasToken
                  ? "Leave blank to keep saved token"
                  : "Optional Bearer token"
              }
              secure
              autoCapitalize="none"
              autoComplete="off"
              help={
                form.mode === "edit" && form.server.hasToken
                  ? "Saved tokens are never shown again. Paste a new value to replace it."
                  : "Stored encrypted on your computer and never shown to bots."
              }
            />

            {form.mode === "edit" && form.server.hasToken ? (
              <View style={styles.clearTokenRow}>
                <Text style={styles.clearTokenLabel} maxFontSizeMultiplier={1.4}>
                  Clear saved token on save
                </Text>
                <Switch
                  value={clearSavedToken}
                  onValueChange={(next) => {
                    setClearSavedToken(next);
                    if (next) clearBearerToken();
                  }}
                  accessibilityLabel="Clear saved token on save"
                  trackColor={{ true: tokens.primary, false: tokens.track }}
                  thumbColor={tokens.text}
                />
              </View>
            ) : null}

            {formError === null ? null : (
              <Text style={styles.formError} accessibilityRole="alert">
                {formError}
              </Text>
            )}

            <View style={styles.formButtons}>
              <TextButton label="Cancel" onPress={closeForm} disabled={busy} />
              <PrimaryButton
                label={busy ? "Saving..." : form.mode === "add" ? "Add server" : "Save changes"}
                onPress={() => void submitForm()}
                busy={busy}
              />
            </View>
          </View>
        ) : null}

        {list.data === null ? (
          <Text style={styles.meta}>Loading...</Text>
        ) : servers.length === 0 && form === null ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle} maxFontSizeMultiplier={1.4}>
              No external MCP servers yet
            </Text>
            <Text style={styles.meta} maxFontSizeMultiplier={1.5}>
              Connect self-hosted Executor ({EXECUTOR_LOCAL_PRESET.url}) or any remote HTTPS MCP
              server to give your bots extra tools.
            </Text>
            <View style={styles.emptyActions}>
              <PrimaryButton label="Add local Executor" onPress={() => openAdd(true)} />
              <TextButton label="Add custom server" onPress={() => openAdd(false)} />
            </View>
          </View>
        ) : (
          servers.map((server) => {
            const id = String(server.serverId);
            const scopeBadge = formatExternalMcpScopeBadge(server.scope, server.scopeId, {
              botName: botNameById,
            });
            const tokenStatus = formatExternalMcpTokenStatus(server.hasToken);
            const testSummary = testResults[id];
            const isTesting = testingId === id;
            return (
              <View key={id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={styles.cardHeaderText}>
                    <Text style={styles.cardTitle} maxFontSizeMultiplier={1.4}>
                      {server.displayName}
                    </Text>
                    <Text style={styles.slug} maxFontSizeMultiplier={1.3}>
                      {server.slug}
                    </Text>
                  </View>
                  <Switch
                    value={server.enabled}
                    disabled={busy}
                    onValueChange={(next) => void toggleEnabled(server, next)}
                    accessibilityLabel={`Enable ${server.displayName}`}
                    trackColor={{ true: tokens.primary, false: tokens.track }}
                    thumbColor={tokens.text}
                  />
                </View>

                <Text style={styles.url} maxFontSizeMultiplier={1.3}>
                  {server.url}
                </Text>

                <View style={styles.badges}>
                  <View style={styles.badge}>
                    <Text style={styles.badgeText} maxFontSizeMultiplier={1.3}>
                      {scopeBadge}
                    </Text>
                  </View>
                  <View style={styles.badge}>
                    <Text style={styles.badgeText} maxFontSizeMultiplier={1.3}>
                      {tokenStatus}
                    </Text>
                  </View>
                </View>

                {testSummary !== undefined ? (
                  <Text
                    style={testSummary.ok ? styles.notice : styles.error}
                    maxFontSizeMultiplier={1.4}
                  >
                    {testSummary.text}
                  </Text>
                ) : null}

                <View style={styles.actions}>
                  <TextButton
                    label={isTesting ? "Testing..." : "Test"}
                    onPress={() => void testServer(server)}
                    disabled={busy || isTesting}
                  />
                  <TextButton label="Edit" onPress={() => openEdit(server)} disabled={busy} />
                  <TextButton
                    label="Delete"
                    onPress={() => confirmDelete(server)}
                    destructive
                    disabled={busy}
                  />
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { padding: 16, gap: 12 },
  intro: { color: tokens.textSecondary, fontSize: 13, lineHeight: 19 },
  meta: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17 },
  error: { color: tokens.danger, fontSize: 13, lineHeight: 18 },
  formError: { color: tokens.danger, fontSize: 13, lineHeight: 18, paddingHorizontal: 16 },
  fieldError: { color: tokens.danger, fontSize: 12, lineHeight: 17 },
  notice: { color: tokens.working, fontSize: 13, lineHeight: 18 },
  emptyCard: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    padding: 16,
    gap: 8,
  },
  emptyTitle: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  emptyActions: { gap: 4, marginTop: 4 },
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    padding: 14,
    gap: 8,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  cardHeaderText: { flex: 1, gap: 2 },
  cardTitle: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  slug: { color: tokens.textSecondary, fontSize: 12 },
  url: { color: tokens.textSecondary, fontSize: 13 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  badge: {
    backgroundColor: tokens.fillMuted,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: { color: tokens.textSecondary, fontSize: 12, fontWeight: "500" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 4, justifyContent: "flex-end" },
  formCard: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    paddingBottom: 8,
    gap: 2,
  },
  formTitle: {
    color: tokens.text,
    fontSize: 17,
    fontWeight: "600",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
  },
  presetRow: {
    flexDirection: "row",
    justifyContent: "flex-start",
    paddingHorizontal: 4,
  },
  scopeSection: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  scopePicker: { gap: 6, marginTop: 4 },
  fieldLabel: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    minHeight: 34,
    borderRadius: 17,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
  },
  chipSelected: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  chipLabel: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  chipLabelSelected: { color: tokens.primaryText },
  clearTokenRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 6,
    gap: 12,
  },
  clearTokenLabel: { color: tokens.textSecondary, fontSize: 14, flex: 1 },
  formButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingHorizontal: 4,
  },
});
