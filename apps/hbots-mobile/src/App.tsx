import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import {
  installJavascriptCrashHandler,
  markBackgrounded,
  markForegrounded,
  markThisRunAlive,
  reportPreviousUncleanExit,
  setCrashBaseUrl,
} from "./crash/crashReporter";
import { apkUrlFor, fetchCompat, type AndroidRelease } from "./compat";
import { describePairFailure } from "./connection";
import { classifyFailure } from "./failure";
import { pair } from "./pairing";
import { describePairingLinkError, parsePairingLink } from "./pairingLink";
import { AppAtomRegistryProvider } from "./personal/atomRegistry";
import { createNativePersonal, type NativePersonal } from "./personal/nativePersonalClient";
import { renewSession } from "./renew";
import { startRenewScheduler, type ForegroundSource } from "./renewScheduler";
import { loadServer, saveServer } from "./serverMemory";
import { clearSession, loadSession, saveSession, type StoredSession } from "./session";
import { createSessionLifetime } from "./sessionLifetime";
import { describeSignOut, revokeRemoteSession } from "./signOut";
import { AppShell } from "./shell/AppShell";
import { COLORS } from "./theme";
import {
  confirmUpdateInstall,
  offerUpdate,
  openInstallPermission,
  readUpdateSnapshot,
  resetUpdater,
  subscribeUpdate,
  type UpdateSnapshot,
} from "./updater";
import { describeSignedOutUpdate, describeUpdate } from "./updateView";
import { isTooOld } from "./version";

const CHATS_SNAPSHOT_KEY = "t3code:chats-snapshot:v3";

type Screen =
  | { readonly kind: "booting" }
  | {
      readonly kind: "unpaired";
      readonly error: string | null;
      readonly notice: string | null;
      readonly requiredVersion: string | null;
    }
  | { readonly kind: "connecting"; readonly step: string }
  | {
      readonly kind: "ready";
      readonly session: StoredSession;
      readonly native: NativePersonal;
    }
  | { readonly kind: "signedOut" }
  | {
      readonly kind: "tooOld";
      readonly session: StoredSession;
      readonly required: string;
      readonly latest: AndroidRelease | null;
    };

markThisRunAlive();
installJavascriptCrashHandler();

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const appForeground: ForegroundSource = {
  subscribe: (onForeground) => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        onForeground();
      }
    });
    return () => subscription.remove();
  },
};

const sessionLifetime = createSessionLifetime({
  renew: renewSession,
  storage: { save: saveSession, clear: clearSession },
});

function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "booting" });
  const [link, setLink] = useState("");
  const [update, setUpdate] = useState<UpdateSnapshot | null>(null);
  const [latest, setLatest] = useState<AndroidRelease | null>(null);
  const [minimumVersion, setMinimumVersion] = useState<string | null>(null);
  const updateRef = useRef<UpdateSnapshot | null>(null);
  const activeSessionRef = useRef<StoredSession | null>(null);
  const nativeRef = useRef<NativePersonal | null>(null);
  const stopRenewRef = useRef<(() => void) | null>(null);

  const setSnapshot = useCallback((snapshot: UpdateSnapshot | null) => {
    updateRef.current = snapshot;
    setUpdate(snapshot);
    sessionLifetime.raise(snapshot?.sessionGeneration ?? 0);
  }, []);

  const installedVersion = update?.installedVersion ?? "";
  const signedOutUpdate = describeSignedOutUpdate(
    latest,
    installedVersion,
    update?.rejected ?? null,
  );

  const activeSession = screen.kind === "ready" || screen.kind === "tooOld" ? screen.session : null;

  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  const stopRenew = useCallback(() => {
    stopRenewRef.current?.();
    stopRenewRef.current = null;
  }, []);

  const disposeNative = useCallback(() => {
    const native = nativeRef.current;
    nativeRef.current = null;
    if (native !== null) {
      void native.dispose();
    }
  }, []);

  const endSession = useCallback(
    async (next: Screen) => {
      stopRenew();
      const native = nativeRef.current;
      if (native !== null) {
        native.client.ports.kv.removeItem(CHATS_SNAPSHOT_KEY);
      }
      disposeNative();
      await sessionLifetime.end();
      await resetUpdater(sessionLifetime.epoch());
      setScreen(next);
    },
    [disposeNative, stopRenew],
  );

  const readCompat = useCallback(async (session: StoredSession, manual: boolean) => {
    const epoch = sessionLifetime.epoch();
    const compat = await fetchCompat(session.httpBaseUrl);
    if (compat === null || sessionLifetime.epoch() !== epoch) {
      return null;
    }
    setLatest(compat.latest);
    setMinimumVersion(compat.minimumNativeVersion);
    const auth =
      compat.latest === null
        ? null
        : {
            apkUrl: apkUrlFor(session.httpBaseUrl, compat.latest),
            bearer: session.accessToken,
          };
    await offerUpdate(compat.latest, auth, manual, epoch);
    return compat;
  }, []);

  const requiresUpdate = useCallback((compat: { minimumNativeVersion: string | null }): boolean => {
    const installed = updateRef.current?.installedVersion ?? "";
    return compat.minimumNativeVersion !== null && isTooOld(installed, compat.minimumNativeVersion);
  }, []);

  const checkForUpdate = useCallback(
    async (session: StoredSession, manual: boolean) => {
      const compat = await readCompat(session, manual);
      if (compat !== null && requiresUpdate(compat)) {
        disposeNative();
        setScreen({
          kind: "tooOld",
          session,
          required: compat.minimumNativeVersion ?? "",
          latest: compat.latest,
        });
      }
    },
    [disposeNative, readCompat, requiresUpdate],
  );

  const goOnline = useCallback(
    async (session: StoredSession, attempt: number) => {
      const epoch = sessionLifetime.epoch();
      disposeNative();
      let native: NativePersonal;
      try {
        native = createNativePersonal(session, updateRef.current?.installedVersion ?? "", {
          onAuthDead: () => {
            void endSession({ kind: "signedOut" });
          },
        });
      } catch (cause) {
        if (classifyFailure(cause).kind === "authDead") {
          await endSession({ kind: "signedOut" });
          return;
        }
        setScreen((previous) =>
          previous.kind === "connecting" ? { kind: "connecting", step: "Starting" } : previous,
        );
        return;
      }
      if (sessionLifetime.epoch() !== epoch) {
        void native.dispose();
        return;
      }
      nativeRef.current = native;
      setCrashBaseUrl(session.httpBaseUrl);
      void reportPreviousUncleanExit();
      setScreen({ kind: "ready", session, native });
      void checkForUpdate(session, false);
      void attempt;
    },
    [checkForUpdate, disposeNative, endSession],
  );

  const startRenew = useCallback(() => {
    stopRenew();
    stopRenewRef.current = startRenewScheduler({
      foreground: appForeground,
      run: async () => {
        const epoch = sessionLifetime.epoch();
        try {
          await sessionLifetime.renew();
        } catch (cause) {
          if (sessionLifetime.epoch() === epoch) {
            throw cause;
          }
        }
      },
      onError: (cause) => {
        if (classifyFailure(cause).kind === "authDead") {
          void endSession({ kind: "signedOut" });
        }
      },
    });
  }, [endSession, stopRenew]);

  useEffect(() => subscribeUpdate(setSnapshot), [setSnapshot]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const snapshot = await readUpdateSnapshot();
      if (!live) {
        return;
      }
      setSnapshot(snapshot);
      const session = await loadSession();
      if (!live) {
        return;
      }
      if (session === null) {
        const server = await loadServer();
        if (!live) {
          return;
        }
        if (server !== null) {
          const compat = await fetchCompat(server);
          if (!live) {
            return;
          }
          if (compat !== null) {
            setLatest(compat.latest);
            setMinimumVersion(compat.minimumNativeVersion);
            await offerUpdate(compat.latest, null, false, sessionLifetime.epoch());
            const installed = snapshot?.installedVersion ?? "";
            if (
              compat.minimumNativeVersion !== null &&
              isTooOld(installed, compat.minimumNativeVersion)
            ) {
              setScreen({
                kind: "unpaired",
                error: null,
                notice: null,
                requiredVersion: compat.minimumNativeVersion,
              });
              return;
            }
          }
        }
        setScreen({ kind: "unpaired", error: null, notice: null, requiredVersion: null });
        return;
      }
      sessionLifetime.restore(session);
      void saveServer(session.httpBaseUrl);
      startRenew();
      await goOnline(session, 0);
    })();
    return () => {
      live = false;
      stopRenew();
      disposeNative();
    };
  }, [disposeNative, goOnline, setSnapshot, startRenew, stopRenew]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        markForegrounded();
      } else {
        markBackgrounded();
      }
      if (next !== "active") {
        return;
      }
      const session = activeSessionRef.current;
      if (session === null) {
        return;
      }
      const snapshot = updateRef.current;
      const lastCheck = snapshot?.lastCheckAt ?? null;
      const stale = lastCheck === null || Date.now() - lastCheck > CHECK_INTERVAL_MS;
      if (snapshot?.state === "needsPermission" || stale) {
        void checkForUpdate(session, false);
      }
    });
    return () => subscription.remove();
  }, [checkForUpdate]);

  useEffect(() => {
    const timer = setInterval(() => {
      const session = activeSessionRef.current;
      if (session !== null) {
        void checkForUpdate(session, false);
      }
    }, RECHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [checkForUpdate]);

  const submitLink = useCallback(async () => {
    const parsed = parsePairingLink(link);
    if (!parsed.ok) {
      setScreen({
        kind: "unpaired",
        error: describePairingLinkError(parsed.error),
        notice: null,
        requiredVersion: minimumVersion,
      });
      return;
    }
    setScreen({ kind: "connecting", step: "Pairing" });
    try {
      const session = await pair(parsed.target);
      await sessionLifetime.adopt(session);
      await saveServer(session.httpBaseUrl);
      setLink("");
      startRenew();
      await goOnline(session, 0);
    } catch (cause) {
      setScreen({
        kind: "unpaired",
        error: describePairFailure(cause),
        notice: null,
        requiredVersion: minimumVersion,
      });
    }
  }, [goOnline, link, minimumVersion, startRenew]);

  const pasteLink = useCallback(async () => {
    setLink(await Clipboard.getStringAsync());
  }, []);

  const signOut = useCallback(
    async (session: StoredSession) => {
      const native = nativeRef.current;
      disposeNative();
      setScreen({ kind: "connecting", step: "Signing out" });
      await sessionLifetime.end();
      await resetUpdater(sessionLifetime.epoch());
      if (native !== null) {
        native.client.ports.kv.removeItem(CHATS_SNAPSHOT_KEY);
      }
      const outcome = await revokeRemoteSession(session);
      await saveServer(session.httpBaseUrl);
      const compat = await fetchCompat(session.httpBaseUrl);
      if (compat !== null) {
        setLatest(compat.latest);
        setMinimumVersion(compat.minimumNativeVersion);
        await offerUpdate(compat.latest, null, false, sessionLifetime.epoch());
      }
      const installed = updateRef.current?.installedVersion ?? "";
      const required = compat?.minimumNativeVersion ?? null;
      setScreen({
        kind: "unpaired",
        error: null,
        notice: describeSignOut(outcome),
        requiredVersion: required !== null && isTooOld(installed, required) ? required : null,
      });
    },
    [disposeNative],
  );

  const confirmSignOut = useCallback(
    (session: StoredSession) => {
      Alert.alert(
        "Sign out this phone?",
        "This removes the sign-in from this phone. Your bots keep running.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Sign out", style: "destructive", onPress: () => void signOut(session) },
        ],
      );
    },
    [signOut],
  );

  const pairAgain = useCallback(() => {
    setScreen({
      kind: "unpaired",
      error: null,
      notice: null,
      requiredVersion:
        minimumVersion !== null && isTooOld(installedVersion, minimumVersion)
          ? minimumVersion
          : null,
    });
  }, [installedVersion, minimumVersion]);

  return (
    <AppAtomRegistryProvider>
      <SafeAreaProvider>
        {screen.kind === "ready" ? (
          <AppShell
            native={screen.native}
            installedVersion={installedVersion}
            update={update}
            latest={latest}
            onCheckNow={() => void checkForUpdate(screen.session, true)}
            onInstall={() => void confirmUpdateInstall()}
            onOpenPermission={() => void openInstallPermission()}
            onSignOut={() => confirmSignOut(screen.session)}
          />
        ) : (
          <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
            <View style={styles.pairScreen}>
              <Text style={styles.brand}>hbots</Text>
              {screen.kind === "booting" || screen.kind === "connecting" ? (
                <View style={styles.status}>
                  <ActivityIndicator color={COLORS.accent} />
                  <Text style={styles.statusText}>
                    {screen.kind === "connecting" ? screen.step : "Starting"}
                  </Text>
                </View>
              ) : screen.kind === "tooOld" ? (
                <>
                  <Text style={styles.headline}>Update hbots to continue</Text>
                  <Text style={styles.help}>
                    Your laptop needs hbots {screen.required} or newer. This phone has{" "}
                    {installedVersion.length > 0 ? installedVersion : "an older version"}.
                  </Text>
                  <View style={styles.noticeBox}>
                    <Text style={styles.notice}>{describeUpdate(update, screen.latest).title}</Text>
                    <Text style={styles.notice}>
                      {describeUpdate(update, screen.latest).detail}
                    </Text>
                  </View>
                  {update?.state === "needsPermission" ? (
                    <Pressable
                      onPress={() => void openInstallPermission()}
                      accessibilityRole="button"
                      style={styles.primaryButton}
                    >
                      <Text style={styles.primaryText}>Allow app installs</Text>
                    </Pressable>
                  ) : update?.state === "ready" || update?.state === "needsTap" ? (
                    <Pressable
                      onPress={() => void confirmUpdateInstall()}
                      accessibilityRole="button"
                      style={styles.primaryButton}
                    >
                      <Text style={styles.primaryText}>Update now</Text>
                    </Pressable>
                  ) : update?.state === "downloading" || update?.state === "installing" ? (
                    <View style={styles.status}>
                      <ActivityIndicator color={COLORS.accent} />
                      <Text style={styles.statusText}>
                        {update.state === "downloading" ? "Downloading" : "Installing"}
                      </Text>
                    </View>
                  ) : (
                    <Pressable
                      onPress={() => void checkForUpdate(screen.session, true)}
                      accessibilityRole="button"
                      style={styles.primaryButton}
                    >
                      <Text style={styles.primaryText}>Check again</Text>
                    </Pressable>
                  )}
                </>
              ) : screen.kind === "signedOut" ? (
                <>
                  <Text style={styles.headline}>You were signed out</Text>
                  <Text style={styles.help}>
                    {
                      "This phone's sign-in ended. Make a new pairing link in hbots Settings > Connections."
                    }
                  </Text>
                  <Pressable
                    onPress={pairAgain}
                    accessibilityRole="button"
                    style={styles.primaryButton}
                  >
                    <Text style={styles.primaryText}>Pair again</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  {screen.requiredVersion !== null ? (
                    <View style={styles.errorBox}>
                      <Text style={styles.error}>
                        This hbots version is too old. Your laptop needs {screen.requiredVersion} or
                        newer. Pair this phone to install the update.
                      </Text>
                    </View>
                  ) : signedOutUpdate !== null ? (
                    <View style={styles.noticeBox}>
                      <Text style={styles.notice}>{signedOutUpdate}</Text>
                    </View>
                  ) : null}
                  {screen.notice !== null ? (
                    <View style={styles.noticeBox}>
                      <Text style={styles.notice}>{screen.notice}</Text>
                    </View>
                  ) : null}
                  <Text style={styles.label}>Pairing link</Text>
                  <TextInput
                    value={link}
                    onChangeText={setLink}
                    placeholder="https://your-server/pair#token=..."
                    placeholderTextColor={COLORS.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    importantForAutofill="no"
                    multiline
                    style={styles.input}
                  />
                  <Pressable
                    onPress={() => void pasteLink()}
                    accessibilityRole="button"
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.secondaryText}>Paste</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void submitLink()}
                    accessibilityRole="button"
                    style={styles.primaryButton}
                  >
                    <Text style={styles.primaryText}>Pair</Text>
                  </Pressable>
                  {screen.error !== null ? (
                    <View style={styles.errorBox}>
                      <Text style={styles.error}>{screen.error}</Text>
                    </View>
                  ) : null}
                </>
              )}
            </View>
          </SafeAreaView>
        )}
      </SafeAreaProvider>
    </AppAtomRegistryProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  flex: { flex: 1 },
  pairScreen: { flex: 1, padding: 20, gap: 12 },
  brand: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.8,
    marginTop: 12,
    marginBottom: 6,
  },
  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusText: { color: COLORS.accent, fontSize: 14, fontWeight: "600" },
  label: { color: COLORS.muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 1 },
  input: {
    minHeight: 76,
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    borderRadius: 12,
    color: COLORS.text,
    padding: 12,
    fontSize: 14,
  },
  primaryButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 6,
  },
  primaryText: { color: "#171509", fontSize: 16, fontWeight: "700" },
  headline: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  help: { color: COLORS.muted, fontSize: 14, lineHeight: 20 },
  secondaryButton: {
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryText: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  noticeBox: {
    backgroundColor: COLORS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    borderRadius: 10,
    padding: 12,
  },
  notice: { color: COLORS.text, fontSize: 13, lineHeight: 18 },
  errorBox: {
    backgroundColor: "#2a1714",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#5a2a22",
    borderRadius: 10,
    padding: 12,
  },
  error: { color: COLORS.danger, fontSize: 13, lineHeight: 18 },
});

export default App;
