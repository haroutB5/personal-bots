import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * A credential being typed. It lives only in this component's state, is
 * cleared the moment the app leaves the foreground, and is never written to a
 * cache, a route parameter or a query key.
 */
export function useSecretDraft(): readonly [string, (value: string) => void, () => void] {
  const [value, setValue] = useState("");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") setValue("");
    });
    return () => subscription.remove();
  }, []);
  return [value, setValue, () => setValue("")] as const;
}
