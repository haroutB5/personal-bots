import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Image,
  KeyboardAvoidingView,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { parsePairingLink } from "../pairingLink";
import { tokens } from "../shell/tokens";
import { failureCopy, type PairingAction, type PairingState } from "./model";

const MARK = require("../../assets/icon/foreground.png");

interface OnboardingScreenProps {
  readonly state: PairingState;
  readonly dispatch: (action: PairingAction) => void;
  readonly defaultLabel: string;
  readonly notice?: string | null;
  readonly onUpdate: () => void;
}

function PrimaryButton({
  label,
  busy = false,
  disabled = false,
  onPress,
}: {
  readonly label: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={[styles.primary, (disabled || busy) && styles.disabled]}
    >
      {busy ? <ActivityIndicator color={tokens.primaryText} size="small" /> : null}
      <Text style={styles.primaryText}>{busy ? `${label}…` : label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  label,
  onPress,
  compact = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.secondary, compact && styles.secondaryCompact]}
    >
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

function Header({
  title,
  onBack,
  action,
}: {
  readonly title: string;
  readonly onBack: () => void;
  readonly action?: React.ReactNode;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={8}
        onPress={onBack}
        style={styles.headerButton}
      >
        <Text style={styles.headerGlyph}>‹</Text>
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerButton}>{action}</View>
    </View>
  );
}

function Welcome({
  dispatch,
  notice,
}: {
  readonly dispatch: (action: PairingAction) => void;
  readonly notice?: string | null;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.welcome}
      bounces={false}
      showsVerticalScrollIndicator={false}
    >
      <Image source={MARK} style={styles.mark} accessibilityIgnoresInvertColors />
      <Text style={styles.brand} accessibilityRole="header">
        hbots
      </Text>
      <Text style={styles.welcomeLine}>Pair this phone with hbots on your laptop.</Text>
      {notice ? (
        <View style={styles.noticeBox}>
          <Text style={styles.notice}>{notice}</Text>
        </View>
      ) : null}
      <View style={styles.welcomeActions}>
        <PrimaryButton label="Scan QR code" onPress={() => dispatch({ type: "scan" })} />
        <SecondaryButton label="Paste a link instead" onPress={() => dispatch({ type: "paste" })} />
        <Text style={styles.footnote}>Make a pairing code in hbots on your laptop.</Text>
      </View>
    </ScrollView>
  );
}

function Scan({
  dispatch,
  onBack,
}: {
  readonly dispatch: (action: PairingAction) => void;
  readonly onBack: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const handled = useRef(false);
  const requested = useRef(false);

  useEffect(() => {
    if (permission === null || requested.current) return;
    if (permission.granted) return;
    requested.current = true;
    void requestPermission().then((next) => {
      if (!next.granted) dispatch({ type: "cameraDenied" });
    });
  }, [dispatch, permission, requestPermission]);

  return (
    <View style={styles.scanScreen}>
      {permission?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return;
            if (!parsePairingLink(data).ok) {
              setMessage("That isn't an hbots pairing link.");
              return;
            }
            handled.current = true;
            dispatch({ type: "submitLink", value: data });
          }}
        />
      ) : (
        <View style={styles.cameraPlaceholder}>
          <ActivityIndicator color={tokens.textSecondary} />
          <Text style={styles.help}>Opening the camera…</Text>
        </View>
      )}
      <View style={[styles.scanTop, styles.scrim]}>
        <Header
          title="Scan code"
          onBack={onBack}
          action={
            <Pressable
              accessibilityRole="switch"
              accessibilityLabel="Torch"
              accessibilityState={{ checked: torch }}
              onPress={() => setTorch((value) => !value)}
              style={styles.headerButton}
            >
              <Text style={styles.headerGlyph}>{torch ? "☀" : "☾"}</Text>
            </Pressable>
          }
        />
      </View>
      <View
        style={styles.viewfinder}
        accessibilityLabel="Camera viewfinder. Point at the pairing code on your laptop."
      />
      <View style={[styles.scanBottom, styles.scrim]}>
        {message !== null ? <Text style={styles.error}>{message}</Text> : null}
        <SecondaryButton label="Paste a link instead" onPress={() => dispatch({ type: "paste" })} />
      </View>
    </View>
  );
}

function Paste({
  state,
  dispatch,
  onBack,
}: {
  readonly state: Extract<PairingState, { step: "paste" }>;
  readonly dispatch: (action: PairingAction) => void;
  readonly onBack: () => void;
}) {
  const paste = async () => {
    const value = await Clipboard.getStringAsync();
    dispatch({ type: "draft", value });
  };
  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding">
      <Header title="Paste link" onBack={onBack} />
      <View style={styles.body}>
        <Text style={styles.label}>Pairing link</Text>
        <TextInput
          value={state.draft}
          onChangeText={(value) => dispatch({ type: "draft", value })}
          placeholder="https://your-server/pair#token=..."
          placeholderTextColor={tokens.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
          multiline
          style={styles.input}
          accessibilityLabel="Pairing link"
        />
        {state.invalid ? (
          <Text style={styles.error}>That isn&apos;t an hbots pairing link.</Text>
        ) : null}
        <SecondaryButton label="Paste" onPress={() => void paste()} compact />
        <PrimaryButton label="Continue" onPress={() => dispatch({ type: "submitPaste" })} />
      </View>
    </KeyboardAvoidingView>
  );
}

function Confirm({
  state,
  dispatch,
  defaultLabel,
  onBack,
}: {
  readonly state: Extract<PairingState, { step: "confirm" }>;
  readonly dispatch: (action: PairingAction) => void;
  readonly defaultLabel: string;
  readonly onBack: () => void;
}) {
  return (
    <View style={styles.flex}>
      <Header title="Pair with this hbots?" onBack={onBack} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{state.server.label}</Text>
          <Text style={styles.cardHost} numberOfLines={1} ellipsizeMode="middle">
            {state.server.host}
          </Text>
          <Text style={styles.cardVersion}>hbots {state.server.serverVersion}</Text>
        </View>
        <Text style={styles.shortId} accessibilityLabel={state.server.shortId.split("").join(" ")}>
          {state.server.shortId}
        </Text>
        <Text style={styles.footnote}>Check this matches the code on your laptop.</Text>
        <PrimaryButton
          label="It matches"
          onPress={() => dispatch({ type: "confirm", defaultLabel })}
        />
        <SecondaryButton label="Cancel" onPress={onBack} />
      </ScrollView>
    </View>
  );
}

function LabelStep({
  state,
  dispatch,
  onBack,
}: {
  readonly state: Extract<PairingState, { step: "label" }>;
  readonly dispatch: (action: PairingAction) => void;
  readonly onBack: () => void;
}) {
  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding">
      <Header title="Name this phone" onBack={onBack} />
      <View style={styles.body}>
        <TextInput
          value={state.label}
          onChangeText={(value) => dispatch({ type: "label", value })}
          placeholder="Find X9 Pro"
          placeholderTextColor={tokens.textTertiary}
          autoCapitalize="words"
          autoCorrect={false}
          maxLength={64}
          style={styles.input}
          accessibilityLabel="Device label"
        />
        <Text style={styles.footnote}>
          Shown in your laptop&apos;s device list. You can sign this phone out from there.
        </Text>
      </View>
      <View style={styles.labelFooter}>
        <PrimaryButton
          label="Pair"
          disabled={state.label.trim().length === 0}
          onPress={() => dispatch({ type: "pair" })}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function Pairing({ state }: { readonly state: Extract<PairingState, { step: "pairing" }> }) {
  return (
    <View style={styles.centered}>
      <ActivityIndicator color={tokens.primary} size="large" />
      <Text style={styles.help}>Pairing with {state.server.label}…</Text>
    </View>
  );
}

function Failed({
  state,
  dispatch,
  onUpdate,
}: {
  readonly state: Extract<PairingState, { step: "failed" }>;
  readonly dispatch: (action: PairingAction) => void;
  readonly onUpdate: () => void;
}) {
  const copy = failureCopy[state.reason];
  const cameraDenied = state.reason === "camera-denied";
  const primary = () => {
    if (state.reason === "app-too-old") {
      onUpdate();
      return;
    }
    if (cameraDenied) {
      void Linking.openSettings();
      return;
    }
    dispatch({ type: "retry" });
  };
  return (
    <View style={styles.failed}>
      <Text style={styles.errorGlyph} accessibilityElementsHidden>
        !
      </Text>
      <Text style={styles.failedHeadline} accessibilityRole="header">
        {copy.headline}
      </Text>
      <Text style={styles.help}>{copy.help}</Text>
      <View style={styles.failedActions}>
        <PrimaryButton label={copy.action} onPress={primary} />
        {cameraDenied ? (
          <SecondaryButton label="Paste a link" onPress={() => dispatch({ type: "paste" })} />
        ) : null}
      </View>
    </View>
  );
}

export function OnboardingScreen({
  state,
  dispatch,
  defaultLabel,
  notice = null,
  onUpdate,
}: OnboardingScreenProps) {
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (state.step === "welcome") return false;
      dispatch({ type: "back" });
      return true;
    });
    return () => subscription.remove();
  }, [dispatch, state.step]);

  const body = (() => {
    switch (state.step) {
      case "welcome":
        return <Welcome dispatch={dispatch} notice={notice} />;
      case "scan":
        return <Scan dispatch={dispatch} onBack={() => dispatch({ type: "back" })} />;
      case "paste":
        return (
          <Paste state={state} dispatch={dispatch} onBack={() => dispatch({ type: "back" })} />
        );
      case "checking":
        return (
          <View style={styles.centered}>
            <ActivityIndicator color={tokens.primary} size="large" />
            <Text style={styles.help}>Checking {new URL(state.link.httpBaseUrl).host}…</Text>
          </View>
        );
      case "confirm":
        return (
          <Confirm
            state={state}
            dispatch={dispatch}
            defaultLabel={defaultLabel}
            onBack={() => dispatch({ type: "back" })}
          />
        );
      case "label":
        return (
          <LabelStep state={state} dispatch={dispatch} onBack={() => dispatch({ type: "back" })} />
        );
      case "pairing":
        return <Pairing state={state} />;
      case "failed":
        return <Failed state={state} dispatch={dispatch} onUpdate={onUpdate} />;
    }
  })();

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  flex: { flex: 1 },
  welcome: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 96, paddingBottom: 24 },
  mark: { width: 64, height: 64, resizeMode: "contain" },
  brand: {
    color: tokens.text,
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -0.8,
    marginTop: 18,
  },
  welcomeLine: { color: tokens.textSecondary, fontSize: 16, lineHeight: 23, marginTop: 10 },
  noticeBox: {
    backgroundColor: tokens.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    borderRadius: 12,
    padding: 12,
    marginTop: 16,
  },
  notice: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  welcomeActions: { marginTop: "auto", gap: 12 },
  footnote: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17, textAlign: "center" },
  primary: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 18,
  },
  disabled: { opacity: 0.45 },
  primaryText: { color: tokens.primaryText, fontSize: 16, fontWeight: "700" },
  secondary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  secondaryCompact: { minHeight: 44, alignItems: "flex-start", paddingHorizontal: 0 },
  secondaryText: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  header: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    gap: 4,
  },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerGlyph: { color: tokens.text, fontSize: 28, lineHeight: 30 },
  headerTitle: { flex: 1, color: tokens.text, fontSize: 17, fontWeight: "600" },
  body: { paddingHorizontal: 20, paddingTop: 8, gap: 12 },
  label: {
    color: tokens.textTertiary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  input: {
    minHeight: 52,
    backgroundColor: tokens.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    borderRadius: 12,
    color: tokens.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  error: { color: tokens.error, fontSize: 13, lineHeight: 18 },
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    padding: 18,
    gap: 4,
  },
  cardLabel: { color: tokens.text, fontSize: 20, fontWeight: "600" },
  cardHost: { color: tokens.textSecondary, fontSize: 14 },
  cardVersion: { color: tokens.textTertiary, fontSize: 12 },
  shortId: {
    color: tokens.text,
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: 4,
    textAlign: "center",
    marginTop: 18,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 24 },
  help: { color: tokens.textSecondary, fontSize: 15, lineHeight: 21, textAlign: "center" },
  labelFooter: { paddingHorizontal: 20, paddingBottom: 12 },
  failed: { flex: 1, paddingHorizontal: 24, paddingTop: 96, gap: 12 },
  errorGlyph: {
    color: tokens.danger,
    fontSize: 32,
    fontWeight: "700",
  },
  failedHeadline: { color: tokens.text, fontSize: 24, fontWeight: "700", letterSpacing: -0.4 },
  failedActions: { marginTop: "auto", gap: 8, paddingBottom: 12 },
  scanScreen: { flex: 1, backgroundColor: "#000000" },
  cameraPlaceholder: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  scrim: { backgroundColor: "rgba(0,0,0,0.55)" },
  scanTop: { paddingTop: 4 },
  scanBottom: { marginTop: "auto", padding: 20, gap: 8 },
  viewfinder: {
    position: "absolute",
    top: "28%",
    left: "20%",
    width: "60%",
    aspectRatio: 1,
    borderRadius: 20,
    borderWidth: 3,
    borderColor: tokens.text,
  },
});
