import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { LockScreen } from "../screens/LockScreen";
import { tokens } from "../shell/tokens";
import { underLock } from "./coverStyle";
import { LockCoveredContext } from "./useLinkGate";
import { useAppLock } from "./useAppLock";

/**
 * Keeps the app mounted underneath, so no state is lost, but not displayed while
 * locked (see {@link underLock}). Links from outside are held until the unlock.
 */
export function AppLockGate({
  children,
  onSignOut,
}: {
  readonly children: ReactNode;
  readonly onSignOut: () => void;
}) {
  const { covered, locked, noScreenLock, unlock } = useAppLock();
  const { display, ...hidden } = underLock(covered);
  return (
    <LockCoveredContext.Provider value={covered}>
      <View style={styles.flex}>
        <View style={[styles.flex, { display }]} {...hidden}>
          {children}
        </View>
        {locked ? (
          <LockScreen onUnlock={unlock} noScreenLock={noScreenLock} onSignOut={onSignOut} />
        ) : covered ? (
          <View style={styles.cover} />
        ) : null}
      </View>
    </LockCoveredContext.Provider>
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
