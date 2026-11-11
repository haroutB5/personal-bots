import { useMemo, type ReactNode } from "react";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { topReserve } from "./callViewModel";
import { useCallView } from "./VoiceCallProvider";

export function TopReserveInsets({ children }: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const reserve = topReserve(useCallView());
  const shifted = useMemo(() => ({ ...insets, top: insets.top + reserve }), [insets, reserve]);
  return (
    <SafeAreaInsetsContext.Provider value={reserve === 0 ? insets : shifted}>
      {children}
    </SafeAreaInsetsContext.Provider>
  );
}
