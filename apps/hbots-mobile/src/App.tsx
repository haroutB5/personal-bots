import * as Device from "expo-device";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import {
  installJavascriptCrashHandler,
  markBackgrounded,
  markForegrounded,
  markThisRunAlive,
  reportPreviousUncleanExit,
  reportUpdaterState,
  setCrashBaseUrl,
} from "./crash/crashReporter";
import { apkUrlFor, fetchCompat, type AndroidRelease } from "./compat";
import { classifyFailure } from "./failure";
import { OnboardingScreen } from "./onboarding/OnboardingScreen";
import { failureFor, reducePairing } from "./onboarding/model";
import { inspectServer, pair } from "./pairing";
import { AppAtomRegistryProvider } from "./personal/atomRegistry";
import { createNativePersonal, type NativePersonal } from "./personal/nativePersonalClient";
import { wipeLocalData } from "./platform/nativePorts";
import { renewSession } from "./renew";
import { startRenewScheduler, type ForegroundSource } from "./renewScheduler";
import { loadServer, saveServer } from "./serverMemory";
import { clearSession, loadSession, saveSession, type StoredSession } from "./session";
import { authMethodOf } from "./sessionAuth";
import { createSessionLifetime } from "./sessionLifetime";
import { describeSignOut, revokeRemoteSession } from "./signOut";
import { UnpairedShareNotice } from "./share/UnpairedShareNotice";
import { unpairedShareMessage } from "./share/unpairedShare";
import { useUnpairedShare } from "./share/useUnpairedShare";
import { AppLockGate } from "./security/AppLockGate";
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
  const [pairing, dispatchPairing] = useReducer(reducePairing, { step: "welcome" as const });
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
    reportUpdaterState(snapshot);
    sessionLifetime.raise(snapshot?.sessionGeneration ?? 0);
  }, []);

  const installedVersion = update?.installedVersion ?? "";
  const signedOutUpdate = describeSignedOutUpdate(
    latest,
    installedVersion,
    update?.rejected ?? null,
  );
  const unpairedShare = useUnpairedShare(screen.kind);
  const unpairedShareText = unpairedShareMessage(unpairedShare.share);
  const pairingNotice =
    screen.kind !== "unpaired"
      ? null
      : screen.requiredVersion !== null
        ? `This hbots version is too old. Your laptop needs ${screen.requiredVersion} or newer. Pair this phone to install the update.`
        : (signedOutUpdate ?? screen.notice);
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
      wipeLocalData();
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
            authMethod: authMethodOf(session),
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
      reportUpdaterState(updateRef.current);
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
        wipeLocalData();
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

  useEffect(() => {
    if (pairing.step !== "checking") return;
    let live = true;
    const required = minimumVersion;
    if (required !== null && isTooOld(installedVersion, required)) {
      dispatchPairing({ type: "checkFailed", reason: "app-too-old" });
      return;
    }
    void inspectServer(pairing.link).then(
      (server) => {
        if (live) dispatchPairing({ type: "checked", server });
      },
      (cause: unknown) => {
        if (live) dispatchPairing({ type: "checkFailed", reason: failureFor(cause) });
      },
    );
    return () => {
      live = false;
    };
  }, [installedVersion, minimumVersion, pairing]);

  useEffect(() => {
    if (pairing.step !== "pairing") return;
    let live = true;
    void (async () => {
      try {
        const session = await pair(pairing.link, pairing.label);
        await sessionLifetime.adopt(session);
        await saveServer(session.httpBaseUrl);
        startRenew();
        await goOnline(session, 0);
      } catch (cause) {
        if (live) dispatchPairing({ type: "pairFailed", reason: failureFor(cause) });
      }
    })();
    return () => {
      live = false;
    };
  }, [goOnline, pairing, startRenew]);

  const signOut = useCallback(
    async (session: StoredSession) => {
      const native = nativeRef.current;
      disposeNative();
      wipeLocalData();
      setScreen({ kind: "connecting", step: "Signing out" });
      await sessionLifetime.end();
      await resetUpdater(sessionLifetime.epoch());
      if (native !== null) {
        native.client.ports.kv.removeItem(CHATS_SNAPSHOT_KEY);
      }
      const outcome = await revokeRemoteSession(session);
      dispatchPairing({ type: "reset" });
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
        "This removes the sign-in, cached chats and notifications from this phone. Your bots keep running.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Sign out", style: "destructive", onPress: () => void signOut(session) },
        ],
      );
    },
    [signOut],
  );

  const pairAgain = useCallback(() => {
    dispatchPairing({ type: "reset" });
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
          <AppLockGate>
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
          </AppLockGate>
        ) : screen.kind === "unpaired" ? (
          <View style={styles.flex}>
            <OnboardingScreen
              state={pairing}
              dispatch={dispatchPairing}
              defaultLabel={Device.modelName ?? "This phone"}
              notice={pairingNotice}
              onUpdate={() =>
                Alert.alert(
                  "Update hbots",
                  "Install the newest hbots from your laptop, then pair this phone again.",
                )
              }
            />
            {unpairedShareText === null ? null : (
              <UnpairedShareNotice
                message={unpairedShareText}
                onOpenSignIn={unpairedShare.dismiss}
              />
            )}
          </View>
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
              ) : (
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
