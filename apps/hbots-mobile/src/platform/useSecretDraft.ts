import { useEffect, useState } from "react";
import { AppState } from "react-native";

import { draftAfterAppState } from "../settings/secretHandling";

/**
 * A credential being typed. It lives only in this component's state, is
 * cleared the moment the app leaves the foreground, and is never written to a
 * cache, a route parameter or a query key.
 */
export function useSecretDraft(): readonly [string, (value: string) => void, () => void] {
  const [value, setValue] = useState("");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setValue((current) => draftAfterAppState(state, current));
    });
    return () => subscription.remove();
  }, []);
  return [value, setValue, () => setValue("")] as const;
}

/** Several credential fields on one form, cleared together when the app leaves. */
export function useSecretDrafts(): readonly [
  Readonly<Record<string, string>>,
  (field: string, value: string) => void,
  () => void,
] {
  const [value, setValue] = useState<Record<string, string>>({});
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setValue((current) =>
        Object.fromEntries(
          Object.keys(current).map((key) => [key, draftAfterAppState(state, current[key] ?? "")]),
        ),
      );
    });
    return () => subscription.remove();
  }, []);
  return [
    value,
    (field, next) => setValue((current) => ({ ...current, [field]: next })),
    () => setValue({}),
  ] as const;
}
