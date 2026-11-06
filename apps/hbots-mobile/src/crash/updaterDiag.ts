import type { UpdateSnapshot } from "../updater";

export interface UpdaterStateBody {
  readonly event: "updater-state";
  readonly state: string;
  readonly targetVersion?: string;
  readonly currentVersion: string;
}

/** Release versions and the state word only. No token, URL or device id. */
export function updaterStateBody(snapshot: UpdateSnapshot): UpdaterStateBody {
  const targetVersion = snapshot.target?.version;
  return {
    event: "updater-state",
    state: snapshot.state,
    ...(targetVersion === undefined ? {} : { targetVersion }),
    currentVersion: snapshot.installedVersion,
  };
}

/**
 * Remembers the last state it reported and returns a body only when the state
 * or its target changes. A launch that finds the updater idle reports nothing.
 */
export function createUpdaterStateTracker(): {
  readonly next: (snapshot: UpdateSnapshot) => UpdaterStateBody | null;
} {
  let last = "idle|";
  return {
    next(snapshot) {
      const key = `${snapshot.state}|${snapshot.target?.version ?? ""}`;
      if (key === last) {
        return null;
      }
      last = key;
      return updaterStateBody(snapshot);
    },
  };
}
