import type { PersonalLoginRequest } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { IconCheck, IconEye, IconEyeOff } from "@tabler/icons-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { useSecureScreen } from "../../platform/secureScreen";
import { tokens } from "../../shell/tokens";
import { cardStyles } from "./cardStyles";
import type { CardContext } from "./types";

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** A bot asking the owner to sign in to a site it needs. */
export function LoginRequestCard({
  request,
  context,
}: {
  readonly request: PersonalLoginRequest;
  readonly context: CardContext;
}) {
  const [status, setStatus] = useState<PersonalLoginRequest["status"]>(request.status);
  const [saved, setSaved] = useState(request.saved);
  const [expired, setExpired] = useState(() => Date.parse(request.expiresAt) <= Date.now());
  const [submitted, setSubmitted] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(true);
  const [visible, setVisible] = useState(false);
  useSecureScreen(status === "pending" || status === "filling");

  useEffect(() => {
    const remaining = Date.parse(request.expiresAt) - Date.now();
    const timer = setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [request.expiresAt]);

  const submit = context.native.client.useAtomCommand(
    context.native.bots.personalLoginRequestsSubmit,
    { reportFailure: false, reportDefect: false },
  );
  const cancel = context.native.client.useAtomCommand(
    context.native.bots.personalLoginRequestsCancel,
    { reportFailure: false, reportDefect: false },
  );
  const host = hostOf(request.origin);

  if (status === "pending" && !expired) {
    const clear = () => {
      setUsername("");
      setPassword("");
      setVisible(false);
    };
    const provide = async () => {
      if (username.length === 0 || password.length === 0 || context.environmentId === null) return;
      const providedUsername = Redacted.make(username);
      const providedPassword = Redacted.make(password);
      clear();
      setSubmitted(true);
      const result = await submit({
        environmentId: context.environmentId,
        input: {
          requestId: request.requestId as never,
          username: providedUsername,
          password: providedPassword,
          save,
        },
      });
      setSubmitted(false);
      if (result._tag === "Success") {
        setStatus(result.value.status);
        setSaved(result.value.saved);
      } else {
        setStatus("fill-failed");
      }
    };
    const cancelRequest = async () => {
      if (context.environmentId === null) return;
      clear();
      setStatus("filling");
      const result = await cancel({
        environmentId: context.environmentId,
        input: { requestId: request.requestId as never },
      });
      setStatus(result._tag === "Success" ? result.value.status : "fill-failed");
    };
    return (
      <View style={cardStyles.card} accessibilityLabel={`${context.botName} needs a sign-in`}>
        <Text style={styles.kicker}>{context.botName} needs a sign-in</Text>
        <Text style={styles.origin}>{request.origin}</Text>
        {request.reason.trim().length > 0 ? (
          <Text style={cardStyles.secondary}>{request.reason}</Text>
        ) : null}
        {submitted ? (
          <Text style={cardStyles.secondary}>Sending your response…</Text>
        ) : (
          <>
            <Text style={styles.label}>Username or email</Text>
            <TextInput
              value={username}
              autoComplete="username"
              autoCorrect={false}
              autoCapitalize="none"
              onChangeText={setUsername}
              style={styles.input}
            />
            <Text style={styles.label}>Password</Text>
            <View style={styles.passwordRow}>
              <TextInput
                value={password}
                secureTextEntry={!visible}
                autoComplete="current-password"
                autoCorrect={false}
                autoCapitalize="none"
                importantForAutofill="no"
                contextMenuHidden
                onChangeText={setPassword}
                style={[styles.input, styles.passwordInput]}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={visible ? "Hide password" : "Show password"}
                accessibilityState={{ checked: visible }}
                onPress={() => setVisible((current) => !current)}
                style={styles.eye}
              >
                {visible ? (
                  <IconEyeOff size={18} color={tokens.textSecondary} strokeWidth={2} />
                ) : (
                  <IconEye size={18} color={tokens.textSecondary} strokeWidth={2} />
                )}
              </Pressable>
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Save for next time</Text>
              <Switch
                value={save}
                onValueChange={setSave}
                accessibilityLabel="Save for next time"
                trackColor={{ false: tokens.track, true: tokens.primary }}
                thumbColor={tokens.text}
              />
            </View>
            <Text style={styles.help}>
              Your details are used only for {host}. {context.botName} never sees them.
            </Text>
            <View style={cardStyles.row}>
              <Pressable
                accessibilityRole="button"
                onPress={() => void cancelRequest()}
                style={({ pressed }) => [
                  cardStyles.button,
                  cardStyles.buttonQuiet,
                  pressed ? cardStyles.pressed : null,
                ]}
              >
                <Text style={[cardStyles.buttonText, cardStyles.buttonQuietText]}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={username.length === 0 || password.length === 0}
                onPress={() => void provide()}
                style={({ pressed }) => [
                  cardStyles.button,
                  cardStyles.buttonPrimary,
                  styles.submit,
                  username.length === 0 || password.length === 0 ? cardStyles.buttonDisabled : null,
                  pressed ? cardStyles.pressed : null,
                ]}
              >
                <Text style={[cardStyles.buttonText, cardStyles.buttonPrimaryText]}>Sign in</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    );
  }

  const settledStatus = status === "pending" ? "expired" : status;
  const text = {
    filling: `Sending details to ${request.origin}…`,
    filled: `Details sent to ${request.origin}${saved ? " · saved" : ""}`,
    cancelled: "Cancelled",
    expired: "This sign-in request expired.",
    "origin-mismatch": "The browser left this site. Request sign-in again on the matching site.",
    "fill-failed": "Couldn't fill the sign-in form. The bot can ask for browser help.",
    pending: "",
  }[settledStatus];
  return (
    <View style={cardStyles.settled} accessibilityLabel={`Sign in to ${host}`}>
      <View style={styles.settledRow}>
        {settledStatus === "filled" ? (
          <IconCheck size={16} color={tokens.text} strokeWidth={2.25} />
        ) : null}
        <Text
          style={[
            styles.settledText,
            settledStatus === "filled" ? null : { color: tokens.textSecondary },
          ]}
        >
          {text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  kicker: {
    color: tokens.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  origin: {
    marginTop: 6,
    color: tokens.textSecondary,
    fontSize: 13,
  },
  label: {
    marginTop: 12,
    marginBottom: 4,
    color: tokens.text,
    fontSize: 13,
  },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 12,
    color: tokens.text,
    fontSize: 16,
  },
  passwordRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  passwordInput: {
    flex: 1,
  },
  eye: {
    position: "absolute",
    right: 4,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  switchRow: {
    marginTop: 10,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  switchLabel: {
    color: tokens.text,
    fontSize: 15,
  },
  help: {
    marginTop: 4,
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  submit: {
    marginLeft: "auto",
    minWidth: 96,
  },
  settledRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  settledText: {
    flex: 1,
    color: tokens.text,
    fontSize: 15,
    lineHeight: 21,
  },
});
