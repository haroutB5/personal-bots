import type { EnvironmentId, PersonalSecretSummary } from "@t3tools/contracts";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import {
  describeSecretPlacement,
  initialSecretAccess,
  PERSONAL_SECRET_BROKER_METHODS,
  secretAccessChoice,
  secretAccessProblem,
  secretAccessStateOf,
  type SecretAccessState,
} from "@hbots/personal-client/settings/secretAccess";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useSecretDraft } from "../platform/useSecretDraft";
import { useSecureScreen } from "../platform/secureScreen";
import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";
import { buildApiKeyInput } from "./secretHandling";
import { Field, PrimaryButton, TextButton } from "./SettingsUi";

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function ApiKeysScreen({
  native,
  onBack,
}: {
  readonly native: NativePersonal;
  readonly onBack: () => void;
}) {
  const insets = useSafeAreaInsets();
  const environmentId = native.environmentId as EnvironmentId;
  useSecureScreen(true);
  const secrets = native.secrets.useSavedSecrets(environmentId);
  const create = native.client.useAtomCommand(native.secrets.personalSecretCreate, {
    reportFailure: false,
  });
  const setSharing = native.client.useAtomCommand(native.secrets.personalSecretSetSharing, {
    reportFailure: false,
  });
  const setMode = native.client.useAtomCommand(native.secrets.personalSecretSetMode, {
    reportFailure: false,
  });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [value, setValue, clearValue] = useSecretDraft();
  const [access, setAccess] = useState<SecretAccessState>(initialSecretAccess());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedAccess, setExpandedAccess] = useState<SecretAccessState>(initialSecretAccess());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = secrets.data?.secrets ?? [];

  const save = async () => {
    setError(null);
    if (name.trim().length === 0) {
      setError("Give the key a name.");
      return;
    }
    if (!NAME_PATTERN.test(name)) {
      setError(
        "Use capitals, digits and underscores, starting with a letter: OPENWEATHER_API_KEY.",
      );
      return;
    }
    if (value.trim().length === 0) {
      setError("Paste the key's value.");
      return;
    }
    const problem = secretAccessProblem(access);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    const result = await create({
      environmentId,
      input: buildApiKeyInput(name, label, value, access),
    });
    const failure = commandFailureMessage(result, "Could not save this key. Try again.");
    if (failure === null) {
      clearValue();
      setAdding(false);
      setName("");
      setLabel("");
      setAccess(initialSecretAccess());
      setNotice("Key saved.");
    } else {
      setError(failure);
    }
    setBusy(false);
  };

  const saveAccess = async (secret: PersonalSecretSummary) => {
    const problem = secretAccessProblem(expandedAccess);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    const choice = secretAccessChoice(expandedAccess);
    const result = await setMode({
      environmentId,
      input: {
        name: secret.name,
        mode: choice.mode,
        origins: [...choice.origins],
        placement: choice.placement,
      },
    });
    const failure = commandFailureMessage(result, "Could not change this key. Try again.");
    if (failure === null) {
      setExpanded(null);
      setNotice("Access saved.");
    } else {
      setError(failure);
    }
    setBusy(false);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader
        title="API keys"
        onBack={onBack}
        right={<TextButton label="Add API key" onPress={() => setAdding(true)} disabled={adding} />}
      />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.intro} maxFontSizeMultiplier={1.5}>
          Keys bots use for outside services, like Tavily and SerpApi. All bots lets every bot use a
          saved key, including bots in other teams; otherwise only the bots that requested it can.
        </Text>
        <Text style={styles.intro} maxFontSizeMultiplier={1.5}>
          Turning sharing off applies to new sessions; running sessions may already have the key.
        </Text>
        <Text style={styles.intro} maxFontSizeMultiplier={1.5}>
          Brokered keys stay on the server: a bot names one in a request and the server adds it, for
          the addresses you set. An environment variable key can be read, and printed, by any bot
          with a shell.
        </Text>
        {secrets.error === null ? null : <Text style={styles.error}>{secrets.error}</Text>}
        {error === null ? null : <Text style={styles.error}>{error}</Text>}
        {notice === null ? null : <Text style={styles.notice}>{notice}</Text>}

        {secrets.data === null ? (
          <Text style={styles.meta}>Loading…</Text>
        ) : rows.length === 0 && !adding ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle} maxFontSizeMultiplier={1.4}>
              No API keys yet
            </Text>
            <Text style={styles.meta} maxFontSizeMultiplier={1.4}>
              Add one here, or ask a bot to set one up when it needs it.
            </Text>
            <PrimaryButton label="Add an API key" onPress={() => setAdding(true)} />
          </View>
        ) : (
          <View style={styles.card}>
            {rows.map((secret, index) => {
              const isOpen = expanded === secret.name;
              return (
                <View
                  key={secret.name}
                  style={[styles.row, index === rows.length - 1 && !isOpen ? null : styles.divider]}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.label} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                      {secret.label.length > 0 ? secret.label : secret.name}
                    </Text>
                    <Text style={styles.name} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                      {secret.name}
                    </Text>
                    <Text style={styles.meta} maxFontSizeMultiplier={1.3}>
                      {secret.mode === "brokered"
                        ? `Brokered${secret.origins.length > 0 ? `: ${secret.origins.join(", ")}` : ""}`
                        : "Environment variable"}
                    </Text>
                    {secret.mode === "brokered" ? (
                      <Text style={styles.meta} maxFontSizeMultiplier={1.3}>
                        {describeSecretPlacement(secret.placement)}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.rowSide}>
                    <Switch
                      value={secret.shared}
                      disabled={busy}
                      onValueChange={(shared) => {
                        void setSharing({
                          environmentId,
                          input: { name: secret.name, shared },
                        }).then((result) => {
                          const failure = commandFailureMessage(
                            result,
                            "Could not change this key. Try again.",
                          );
                          if (failure !== null) setError(failure);
                        });
                      }}
                      accessibilityLabel={`Allow all bots to use ${secret.name}`}
                      trackColor={{ true: tokens.primary, false: tokens.track }}
                      thumbColor={tokens.text}
                    />
                    <TextButton
                      label={secret.mode === "brokered" ? "Change access" : "Make brokered"}
                      onPress={() => {
                        if (isOpen) setExpanded(null);
                        else {
                          setExpanded(secret.name);
                          setExpandedAccess(secretAccessStateOf(secret));
                        }
                      }}
                    />
                  </View>
                  {isOpen ? (
                    <View style={styles.accessPanel}>
                      <SecretAccessFields state={expandedAccess} onChange={setExpandedAccess} />
                      <Text style={styles.meta} maxFontSizeMultiplier={1.4}>
                        Applies to new sessions; a session that is already running may still hold
                        the key as an environment variable.
                      </Text>
                      <View style={styles.formButtons}>
                        <TextButton label="Cancel" onPress={() => setExpanded(null)} />
                        <PrimaryButton
                          label={busy ? "Saving…" : "Save access"}
                          onPress={() => void saveAccess(secret)}
                          busy={busy}
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}

        {adding ? (
          <View style={styles.form}>
            <Text style={styles.formTitle} maxFontSizeMultiplier={1.4}>
              Add API key
            </Text>
            <Field
              label="Name"
              value={name}
              onChangeText={(next) => setName(next.toUpperCase())}
              placeholder="OPENWEATHER_API_KEY"
              autoCapitalize="characters"
              autoComplete="off"
              help={`Bots ask for this key by name ({{secret:${name.length > 0 ? name : "NAME"}}}), so it has to match the name the bot looks for.`}
            />
            <Field
              label="Label (optional)"
              value={label}
              onChangeText={setLabel}
              placeholder="What you call it in this list"
              autoComplete="off"
            />
            <Field
              label="Value"
              value={value}
              onChangeText={setValue}
              secure
              autoCapitalize="none"
              autoComplete="off"
              help="Saved on your computer and never shown in a chat."
            />
            <SecretAccessFields state={access} onChange={setAccess} />
            <View style={styles.formButtons}>
              <TextButton
                label="Cancel"
                onPress={() => {
                  clearValue();
                  setAdding(false);
                  setError(null);
                }}
              />
              <PrimaryButton
                label={busy ? "Saving…" : "Save key"}
                onPress={() => void save()}
                busy={busy}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SecretAccessFields({
  state,
  onChange,
}: {
  readonly state: SecretAccessState;
  readonly onChange: (state: SecretAccessState) => void;
}) {
  const [advanced, setAdvanced] = useState(
    state.placement.header.length > 0 ||
      state.placement.anywhere ||
      state.placement.pathPrefix.length > 0 ||
      state.placement.methods.length > 0,
  );
  return (
    <View style={styles.access}>
      <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.4}>
        How bots use this key
      </Text>
      <Pressable
        onPress={() => onChange({ ...state, mode: "brokered" })}
        accessibilityRole="radio"
        accessibilityState={{ selected: state.mode === "brokered" }}
        style={styles.option}
      >
        <Text style={styles.optionTitle}>Brokered (safer)</Text>
        <Text style={styles.meta}>
          Bots can use it only through the server, for the address below, and never see the key.
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onChange({ ...state, mode: "env" })}
        accessibilityRole="radio"
        accessibilityState={{ selected: state.mode === "env" }}
        style={styles.option}
      >
        <Text style={styles.optionTitle}>Environment variable</Text>
        <Text style={styles.meta}>
          Bots can read it in the shell and could print it into a chat.
        </Text>
      </Pressable>
      {state.mode === "brokered" ? (
        <>
          <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.4}>
            Allowed address
          </Text>
          <TextInput
            value={state.originsText}
            onChangeText={(originsText) => onChange({ ...state, originsText })}
            placeholder="https://api.vercel.com"
            placeholderTextColor={tokens.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Allowed address"
            style={styles.input}
          />
          <Text style={styles.meta}>
            The server adds the key only to requests sent here. Separate several addresses with a
            space.
          </Text>
          <TextButton
            label={advanced ? "Hide where the key may go" : "Where the key may go (advanced)"}
            onPress={() => setAdvanced(!advanced)}
          />
          {advanced ? (
            <View style={styles.advanced}>
              <Text style={styles.meta}>
                By default a bot can put the key only in the Authorization header. Allow more only
                if the API needs it.
              </Text>
              <Field
                label="Another header it may go in"
                value={state.placement.header}
                onChangeText={(header) =>
                  onChange({ ...state, placement: { ...state.placement, header } })
                }
                placeholder="x-api-key"
                autoCapitalize="none"
                autoComplete="off"
              />
              <View style={styles.switchRow}>
                <Text style={styles.optionTitle} maxFontSizeMultiplier={1.4}>
                  Also allow it in the web address and the request body
                </Text>
                <Switch
                  value={state.placement.anywhere}
                  onValueChange={(anywhere) =>
                    onChange({ ...state, placement: { ...state.placement, anywhere } })
                  }
                  trackColor={{ true: tokens.primary, false: tokens.track }}
                  thumbColor={tokens.text}
                />
              </View>
              <Field
                label="Only for paths starting with (optional)"
                value={state.placement.pathPrefix}
                onChangeText={(pathPrefix) =>
                  onChange({ ...state, placement: { ...state.placement, pathPrefix } })
                }
                placeholder="/v1"
                autoCapitalize="none"
                autoComplete="off"
              />
              <Text style={styles.meta}>Only these methods (none ticked means all)</Text>
              <View style={styles.methods}>
                {PERSONAL_SECRET_BROKER_METHODS.map((method) => {
                  const selected = state.placement.methods.includes(method);
                  return (
                    <Pressable
                      key={method}
                      onPress={() =>
                        onChange({
                          ...state,
                          placement: {
                            ...state.placement,
                            methods: selected
                              ? state.placement.methods.filter((entry) => entry !== method)
                              : [...state.placement.methods, method],
                          },
                        })
                      }
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                      style={[styles.method, selected ? styles.methodSelected : null]}
                    >
                      <Text style={styles.methodLabel}>{method}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}
        </>
      ) : null}
      {describeSecretPlacement(state.placement) === "" ? null : (
        <Text style={styles.meta} maxFontSizeMultiplier={1.3}>
          {describeSecretPlacement(state.placement)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { padding: 16, gap: 12 },
  intro: { color: tokens.textSecondary, fontSize: 13, lineHeight: 19 },
  meta: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17 },
  error: { color: tokens.danger, fontSize: 13, lineHeight: 18 },
  notice: { color: tokens.working, fontSize: 13, lineHeight: 18 },
  empty: { gap: 8, paddingVertical: 16 },
  emptyTitle: { color: tokens.text, fontSize: 17, fontWeight: "600" },
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    overflow: "hidden",
  },
  row: { paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
  rowText: { gap: 2 },
  rowSide: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 },
  label: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  name: { color: tokens.textSecondary, fontSize: 13 },
  accessPanel: {
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingTop: 8,
  },
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
  access: { gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  fieldLabel: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  option: { gap: 2, paddingVertical: 6 },
  optionTitle: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
    color: tokens.text,
    fontSize: 15,
    paddingHorizontal: 12,
  },
  advanced: { gap: 8 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  methods: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  method: {
    minHeight: 32,
    borderRadius: 16,
    paddingHorizontal: 10,
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  methodSelected: { backgroundColor: tokens.primary },
  methodLabel: { color: tokens.textSecondary, fontSize: 12 },
});
