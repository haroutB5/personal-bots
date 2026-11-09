import type { EnvironmentId, PersonalLogin } from "@t3tools/contracts";
import { PersonalLoginId } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import {
  emptyPasswordDraft,
  passwordDraftFromLogin,
  validatePasswordDraft,
  type PasswordDraft,
  type PasswordDraftErrors,
} from "@hbots/personal-client/settings/passwordsModel";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useSecretDraft } from "../platform/useSecretDraft";
import { useSecureScreen } from "../platform/secureScreen";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { buildLoginInput } from "./secretHandling";
import { Field, PrimaryButton, TextButton } from "./SettingsUi";

type Editing = { readonly kind: "new" } | { readonly kind: "edit"; readonly login: PersonalLogin };

export function PasswordsScreen({
  native,
  onBack,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId as EnvironmentId;
  useSecureScreen(true);
  const logins = native.logins.usePersonalLogins(environmentId);
  const create = native.client.useAtomCommand(native.logins.personalLoginCreate, {
    reportFailure: false,
  });
  const update = native.client.useAtomCommand(native.logins.personalLoginUpdate, {
    reportFailure: false,
  });
  const remove = native.client.useAtomCommand(native.logins.personalLoginDelete, {
    reportFailure: false,
  });
  const removeMany = native.client.useAtomCommand(native.logins.personalLoginsDeleteMany, {
    reportFailure: false,
  });
  const setSensitive = native.client.useAtomCommand(native.logins.personalLoginSetSensitive, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState<PasswordDraft>(emptyPasswordDraft());
  const [password, setPassword, clearPassword] = useSecretDraft();
  const [errors, setErrors] = useState<PasswordDraftErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState<ReadonlyArray<string>>([]);

  const rows = logins.data?.logins ?? [];
  const openNew = () => {
    setEditing({ kind: "new" });
    setDraft(emptyPasswordDraft());
    clearPassword();
    setErrors({});
    setSubmitError(null);
  };
  const openEdit = (login: PersonalLogin) => {
    setEditing({ kind: "edit", login });
    setDraft(passwordDraftFromLogin(login));
    clearPassword();
    setErrors({});
    setSubmitError(null);
  };
  const closeForm = () => {
    setEditing(null);
    clearPassword();
    setErrors({});
    setSubmitError(null);
  };

  const save = async () => {
    const withPassword = { ...draft, password };
    const found = validatePasswordDraft(withPassword);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setSubmitError(null);
      return;
    }
    setBusy(true);
    setSubmitError(null);
    const loginId =
      editing?.kind === "edit"
        ? editing.login.loginId
        : PersonalLoginId.make(native.client.ports.ids.randomUUID());
    const input = buildLoginInput(loginId, draft, password);
    const result =
      editing?.kind === "edit"
        ? await update({ environmentId, input })
        : await create({ environmentId, input });
    const failure = commandFailureMessage(result, "The login could not be saved.");
    if (failure === null) {
      setNotice("Login saved.");
      closeForm();
    } else {
      setSubmitError(failure);
    }
    setBusy(false);
  };

  const confirmDelete = (login: PersonalLogin) => {
    Alert.alert(`Delete ${login.label}?`, "Bots will no longer be able to use this login.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete login",
        style: "destructive",
        onPress: () => {
          void (async () => {
            const result = await remove({ environmentId, input: { loginId: login.loginId } });
            const failure = commandFailureMessage(result, "Could not delete that login.");
            if (failure !== null) setNotice(failure);
            else setNotice("Login deleted.");
          })();
        },
      },
    ]);
  };

  const confirmBulk = () => {
    if (chosen.length === 0) return;
    Alert.alert(
      `Delete ${chosen.length === 1 ? "1 saved login" : `${chosen.length} saved logins`}?`,
      `Bots won't be able to sign in to ${chosen.length === 1 ? "this site" : "these sites"}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: `Delete ${chosen.length === 1 ? "1 saved login" : `${chosen.length} saved logins`}`,
          style: "destructive",
          onPress: () => {
            void (async () => {
              setBusy(true);
              const result = await removeMany({
                environmentId,
                input: { loginIds: chosen.slice(0, 500) as never },
              });
              const failure = commandFailureMessage(result, "Could not delete those logins.");
              if (failure !== null) setNotice(failure);
              else {
                setNotice(`Deleted ${chosen.length} logins.`);
                setChosen([]);
                setSelecting(false);
              }
              setBusy(false);
            })();
          },
        },
      ],
    );
  };

  const toggle = (loginId: string) => {
    setChosen((current) =>
      current.includes(loginId)
        ? current.filter((entry) => entry !== loginId)
        : [...current, loginId],
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      {selecting ? (
        <View style={styles.selectHeader}>
          <TextButton
            label="Cancel"
            onPress={() => {
              setSelecting(false);
              setChosen([]);
            }}
          />
          <Text style={styles.selectTitle}>
            {chosen.length === 0 ? "Select logins" : `${chosen.length} selected`}
          </Text>
          <TextButton
            label={chosen.length === rows.length && rows.length > 0 ? "Deselect all" : "Select all"}
            onPress={() =>
              setChosen(
                chosen.length === rows.length ? [] : rows.map((login) => String(login.loginId)),
              )
            }
          />
        </View>
      ) : (
        <ScreenHeader
          title="Passwords"
          onBack={onBack}
          right={<TextButton label="Add login" onPress={openNew} />}
        />
      )}
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 96 }]}
        keyboardShouldPersistTaps="handled"
      >
        {selecting ? null : (
          <Text style={styles.intro} maxFontSizeMultiplier={1.5}>
            Any bot can use saved logins on their exact site. Passwords are encrypted on this
            computer, but bots run under your computer account and share one signed-in browser, so
            only save accounts you trust every bot to use.{"\n\n"}
            Sensitive sites (your bank, your email): once a bot has one open, anything it does in
            the browser that could send what it saw to a different site asks you first. Everything
            else runs unattended.
          </Text>
        )}
        {notice === null ? null : (
          <Text style={styles.notice} maxFontSizeMultiplier={1.4}>
            {notice}
          </Text>
        )}

        {logins.data === null ? (
          <Text style={styles.meta}>{logins.error ?? "Loading…"}</Text>
        ) : rows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle} maxFontSizeMultiplier={1.4}>
              No logins yet
            </Text>
            <Text style={styles.meta} maxFontSizeMultiplier={1.4}>
              Save a site's login once and any bot can sign in to it for you.
            </Text>
            {editing === null ? <PrimaryButton label="Save a login" onPress={openNew} /> : null}
          </View>
        ) : (
          <View style={styles.card}>
            {rows.map((login, index) => (
              <View
                key={login.loginId}
                style={[styles.row, index === rows.length - 1 ? null : styles.divider]}
              >
                <Pressable
                  onPress={() => (selecting ? toggle(String(login.loginId)) : openEdit(login))}
                  onLongPress={() => {
                    setSelecting(true);
                    setChosen([String(login.loginId)]);
                  }}
                  accessibilityRole={selecting ? "checkbox" : "button"}
                  accessibilityState={
                    selecting ? { checked: chosen.includes(String(login.loginId)) } : {}
                  }
                  style={styles.rowText}
                >
                  <Text style={styles.label} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                    {login.label}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                    {login.origin}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                    {login.username}
                  </Text>
                </Pressable>
                {selecting ? (
                  <Text style={styles.check}>
                    {chosen.includes(String(login.loginId)) ? "☑" : "☐"}
                  </Text>
                ) : (
                  <>
                    <Switch
                      value={login.sensitive}
                      onValueChange={(sensitive) => {
                        void setSensitive({
                          environmentId,
                          input: { loginId: login.loginId, sensitive },
                        }).then((result) => {
                          const failure = commandFailureMessage(
                            result,
                            "Could not change that login.",
                          );
                          if (failure !== null) setNotice(failure);
                        });
                      }}
                      accessibilityLabel={`Sensitive site: ${login.label}`}
                      trackColor={{ true: tokens.primary, false: tokens.track }}
                      thumbColor={tokens.text}
                    />
                    <TextButton label="Delete" onPress={() => confirmDelete(login)} destructive />
                  </>
                )}
              </View>
            ))}
          </View>
        )}

        {editing === null || selecting ? null : (
          <View
            style={styles.form}
            key={editing.kind === "edit" ? String(editing.login.loginId) : "new"}
          >
            <Text style={styles.formTitle} maxFontSizeMultiplier={1.4}>
              {editing.kind === "edit" ? `Edit ${editing.login.label}` : "Add login"}
            </Text>
            <Field
              label="Label"
              value={draft.label}
              onChangeText={(label) => setDraft({ ...draft, label })}
              placeholder="Work email"
              autoComplete="off"
              error={errors.label}
            />
            <Field
              label="Website origin"
              value={draft.origin}
              onChangeText={(origin) => setDraft({ ...draft, origin })}
              placeholder="https://example.com"
              keyboardType="url"
              autoCapitalize="none"
              autoComplete="off"
              help="Any bot can fill this login, and only while the browser is on this exact origin."
              error={errors.origin}
            />
            <Field
              label="Username"
              value={draft.username}
              onChangeText={(username) => setDraft({ ...draft, username })}
              autoCapitalize="none"
              autoComplete="username"
            />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secure
              autoCapitalize="none"
              autoComplete="new-password"
              help="Write-only. Re-enter it whenever you edit this login."
              error={errors.password}
            />
            {submitError === null ? null : <Text style={styles.notice}>{submitError}</Text>}
            <View style={styles.formButtons}>
              <TextButton label="Cancel" onPress={closeForm} />
              <PrimaryButton
                label={busy ? "Saving…" : "Save login"}
                onPress={() => void save()}
                busy={busy}
              />
            </View>
          </View>
        )}
      </ScrollView>
      {selecting ? (
        <View style={[styles.selectBar, { paddingBottom: insets.bottom }]}>
          <PrimaryButton
            label={
              chosen.length === 0
                ? "Delete"
                : `Delete ${chosen.length} ${chosen.length === 1 ? "login" : "logins"}`
            }
            onPress={confirmBulk}
            disabled={chosen.length === 0}
            busy={busy}
            destructive
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { padding: 16, gap: 12 },
  intro: { color: tokens.textSecondary, fontSize: 13, lineHeight: 19 },
  notice: { color: tokens.danger, fontSize: 13, lineHeight: 18 },
  meta: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17 },
  empty: { gap: 8, paddingVertical: 16 },
  emptyTitle: { color: tokens.text, fontSize: 17, fontWeight: "600" },
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    overflow: "hidden",
  },
  row: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
  rowText: { flex: 1, gap: 2 },
  label: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  check: { color: tokens.text, fontSize: 20 },
  form: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    gap: 4,
    paddingBottom: 8,
  },
  formTitle: { color: tokens.text, fontSize: 17, fontWeight: "600", padding: 16, paddingBottom: 4 },
  formButtons: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center" },
  selectHeader: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
    paddingHorizontal: 4,
  },
  selectTitle: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  selectBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: tokens.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingTop: 4,
  },
});
