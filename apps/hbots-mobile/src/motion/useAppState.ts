import { useEffect, useState } from "react";
import { AppState } from "react-native";

export function useAppState(): string {
  const [state, setState] = useState(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", setState);
    return () => subscription.remove();
  }, []);
  return state;
}
