import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { LockScreen } from "../screens/LockScreen";
import { tokens } from "../shell/tokens";
import { useCallLockLine, useCallSession } from "../voice/VoiceCallProvider";
import { useAppLock } from "./useAppLock";

/** Keeps the app mounted underneath and hides it from the screen and from screen readers while locked. */
export function AppLockGate({ children }: { readonly children: ReactNode }) {
  const { covered, locked, unlock } = useAppLock();
  const callLine = useCallLockLine();
  const callSession = useCallSession();
  return (
    <View style={styles.flex}>
      <View
        style={styles.flex}
        importantForAccessibility={covered ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={covered}
      >
        {children}
      </View>
      {locked ? (
        <LockScreen
          onUnlock={unlock}
          call={callLine}
          onHangUp={callSession === null ? undefined : () => callSession.end("hung_up")}
        />
      ) : covered ? (
        <View style={styles.cover} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  cover: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: tokens.bg,
  },
});
