import { PERSONAL_SECRET_BROKER_METHODS, type PersonalSecretMode } from "@t3tools/contracts";
import {
  secretAccessProblem,
  type SecretAccessState,
  type SecretPlacementState,
} from "@hbots/personal-client/settings/secretAccess";
import { IconCheck } from "@tabler/icons-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { tokens } from "../../shell/tokens";
import { cardStyles } from "./cardStyles";

function Choice({
  selected,
  label,
  body,
  disabled,
  onPress,
}: {
  readonly selected: boolean;
  readonly label: string;
  readonly body: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        selected ? styles.choiceSelected : null,
        disabled ? cardStyles.buttonDisabled : null,
        pressed ? cardStyles.pressed : null,
      ]}
    >
      <View style={[styles.radio, selected ? styles.radioSelected : null]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.choiceTitle}>{label}</Text>
        <Text style={styles.choiceBody}>{body}</Text>
      </View>
    </Pressable>
  );
}

function CheckRow({
  checked,
  label,
  detail,
  disabled,
  onPress,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly detail?: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.checkRow,
        disabled ? cardStyles.buttonDisabled : null,
        pressed ? cardStyles.pressed : null,
      ]}
    >
      <View style={[styles.checkBox, checked ? styles.checkBoxOn : null]}>
        {checked ? <IconCheck size={13} color={tokens.primaryText} strokeWidth={3} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.checkLabel}>{label}</Text>
        {detail === undefined ? null : <Text style={styles.checkDetail}>{detail}</Text>}
      </View>
    </Pressable>
  );
}

function PlacementFields({
  state,
  onChange,
  disabled,
}: {
  readonly state: SecretPlacementState;
  readonly onChange: (next: SecretPlacementState) => void;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState(
    state.header !== "" || state.anywhere || state.pathPrefix !== "" || state.methods.length > 0,
  );
  return (
    <View style={styles.placement}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [styles.placementToggle, pressed ? cardStyles.pressed : null]}
      >
        <Text style={styles.placementTitle}>Where the key may go (advanced)</Text>
      </Pressable>
      {open ? (
        <View>
          <Text style={styles.help}>
            By default a bot can put the key only in the Authorization header. Allow more only if
            the API needs it.
          </Text>
          <Text style={styles.label}>Another header it may go in</Text>
          <TextInput
            value={state.header}
            editable={!disabled}
            autoComplete="off"
            autoCorrect={false}
            autoCapitalize="none"
            placeholder="x-api-key"
            placeholderTextColor={tokens.textTertiary}
            onChangeText={(header) => onChange({ ...state, header })}
            style={styles.input}
          />
          <CheckRow
            checked={state.anywhere}
            label="Also allow it in the web address and the request body"
            detail="A key there can end up in the API's logs."
            disabled={disabled}
            onPress={() => onChange({ ...state, anywhere: !state.anywhere })}
          />
          <Text style={styles.label}>Only for paths starting with (optional)</Text>
          <TextInput
            value={state.pathPrefix}
            editable={!disabled}
            autoComplete="off"
            autoCorrect={false}
            autoCapitalize="none"
            placeholder="/v1"
            placeholderTextColor={tokens.textTertiary}
            onChangeText={(pathPrefix) => onChange({ ...state, pathPrefix })}
            style={styles.input}
          />
          <Text style={styles.label}>Only these methods (none ticked means all)</Text>
          <View style={styles.methods}>
            {PERSONAL_SECRET_BROKER_METHODS.map((method) => (
              <CheckRow
                key={method}
                checked={state.methods.includes(method)}
                label={method}
                disabled={disabled}
                onPress={() =>
                  onChange({
                    ...state,
                    methods: state.methods.includes(method)
                      ? state.methods.filter((entry) => entry !== method)
                      : [...state.methods, method],
                  })
                }
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * How a bot may use a key, shared with the web form: brokered (the server sends
 * the request and the bot never sees the value) or an environment variable.
 */
export function SecretAccessFields({
  state,
  onChange,
  disabled = false,
  showProblem = false,
  botName,
  showPlacement = false,
}: {
  readonly state: SecretAccessState;
  readonly onChange: (next: SecretAccessState) => void;
  readonly showPlacement?: boolean;
  readonly disabled?: boolean;
  readonly showProblem?: boolean;
  readonly botName?: string;
}) {
  const problem = secretAccessProblem(state);
  const who = botName ?? "bots";
  const options: ReadonlyArray<{
    readonly mode: PersonalSecretMode;
    readonly title: string;
    readonly body: string;
  }> = [
    {
      mode: "brokered",
      title: "Brokered (safer)",
      body: `${who === "bots" ? "Bots" : who} can use it only through the server, for the address below, and never see the key.`,
    },
    {
      mode: "env",
      title: "Environment variable",
      body: `${who === "bots" ? "Bots" : who} can read it in the shell and could print it into a chat.`,
    },
  ];
  return (
    <View accessibilityRole="radiogroup">
      <View style={{ gap: 8 }}>
        {options.map((option) => (
          <Choice
            key={option.mode}
            selected={state.mode === option.mode}
            label={option.title}
            body={option.body}
            disabled={disabled}
            onPress={() => onChange({ ...state, mode: option.mode })}
          />
        ))}
      </View>
      {state.mode === "brokered" ? (
        <View style={{ marginTop: 12 }}>
          <Text style={styles.label}>Allowed address</Text>
          <TextInput
            value={state.originsText}
            editable={!disabled}
            inputMode="url"
            autoComplete="off"
            autoCorrect={false}
            autoCapitalize="none"
            placeholder="https://api.vercel.com"
            placeholderTextColor={tokens.textTertiary}
            onChangeText={(originsText) => onChange({ ...state, originsText })}
            style={[styles.input, showProblem && problem !== null ? styles.inputInvalid : null]}
          />
          <Text style={styles.help}>
            The server adds the key only to requests sent here. Separate several addresses with a
            space.
          </Text>
          {showProblem && problem !== null ? <Text style={cardStyles.error}>{problem}</Text> : null}
          {showPlacement ? (
            <PlacementFields
              state={state.placement}
              disabled={disabled}
              onChange={(placement) => onChange({ ...state, placement })}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  choice: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  choiceSelected: {
    borderColor: tokens.text,
    backgroundColor: tokens.fillMuted,
  },
  radio: {
    marginTop: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  radioSelected: {
    borderColor: tokens.text,
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: tokens.text,
  },
  choiceTitle: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "500",
  },
  choiceBody: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  label: {
    marginTop: 12,
    marginBottom: 4,
    color: tokens.text,
    fontSize: 14,
    fontWeight: "500",
  },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.fillMuted,
    paddingHorizontal: 12,
    color: tokens.text,
    fontSize: 16,
  },
  inputInvalid: {
    borderColor: tokens.danger,
  },
  help: {
    marginTop: 6,
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  placement: {
    marginTop: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.border,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  placementToggle: {
    minHeight: 44,
    justifyContent: "center",
  },
  placementTitle: {
    color: tokens.text,
    fontSize: 14,
    fontWeight: "500",
  },
  checkRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 6,
  },
  checkBox: {
    marginTop: 2,
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: tokens.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkBoxOn: {
    borderColor: tokens.primary,
    backgroundColor: tokens.primary,
  },
  checkLabel: {
    color: tokens.text,
    fontSize: 15,
    lineHeight: 21,
  },
  checkDetail: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  methods: {
    marginTop: 2,
  },
});
