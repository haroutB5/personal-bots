import { requireOptionalNativeModule } from "expo";

import type { AndroidRelease } from "./compat";

export type UpdateStateKind =
  | "idle"
  | "downloading"
  | "ready"
  | "installing"
  | "needsTap"
  | "needsPermission";

export interface UpdateTarget {
  readonly version: string;
  readonly sha256: string;
  readonly size: number;
}

export interface UpdateSnapshot {
  readonly installedVersion: string;
  readonly installedCode: number;
  readonly state: UpdateStateKind;
  readonly target: UpdateTarget | null;
  readonly rejected: string | null;
  readonly lastCheckAt: number | null;
  readonly sessionGeneration: number;
  readonly testPin: boolean;
}

export interface UpdateAuth {
  readonly apkUrl: string;
  readonly bearer: string;
}

interface NativeUpdater {
  offer(
    release: AndroidRelease | null,
    auth: UpdateAuth | null,
    options: { readonly manual: boolean; readonly generation: number },
  ): Promise<void>;
  snapshot(): Promise<UpdateSnapshot>;
  confirmInstall(): Promise<void>;
  reset(generation: number): Promise<void>;
  openInstallPermission(): Promise<void>;
  addListener(
    event: "state",
    listener: (snapshot: UpdateSnapshot) => void,
  ): { readonly remove: () => void };
}

const native = requireOptionalNativeModule<NativeUpdater>("HbotsUpdater");

export function updaterAvailable(): boolean {
  return native !== null;
}

export async function readUpdateSnapshot(): Promise<UpdateSnapshot | null> {
  if (native === null) {
    return null;
  }
  try {
    return await native.snapshot();
  } catch {
    return null;
  }
}

export async function offerUpdate(
  release: AndroidRelease | null,
  auth: UpdateAuth | null,
  manual: boolean,
  generation: number,
): Promise<void> {
  if (native === null) {
    return;
  }
  try {
    await native.offer(release, auth, { manual, generation });
  } catch {
    // A failed offer leaves the last state alone. The next compat read retries.
  }
}

export async function confirmUpdateInstall(): Promise<void> {
  if (native === null) {
    return;
  }
  await native.confirmInstall();
}

export async function resetUpdater(generation: number): Promise<void> {
  if (native === null) {
    return;
  }
  try {
    await native.reset(generation);
  } catch {
    // A failed reset leaves the last state alone. The next sign out retries.
  }
}

export async function openInstallPermission(): Promise<void> {
  if (native === null) {
    return;
  }
  await native.openInstallPermission();
}

export function subscribeUpdate(listener: (snapshot: UpdateSnapshot) => void): () => void {
  if (native === null || typeof native.addListener !== "function") {
    return () => undefined;
  }
  const subscription = native.addListener("state", listener);
  return () => subscription.remove();
}
