import type { Cancel } from "./cancel.ts";

export type LifecycleState = "foreground" | "background";

export interface Lifecycle {
  current(): LifecycleState;
  subscribe(listener: (state: LifecycleState) => void): Cancel;
}
