import { useSyncExternalStore } from "react";

/**
 * Bytes sent for the attachment uploads the composer is waiting on, by message
 * id. Only ranged uploads (videos and large files) report; the composer shows
 * a bar with Cancel while one is running.
 */
export interface UploadProgress {
  /** Storage key of the chat that sent it, so only that chat's composer shows the bar. */
  readonly chatKey: string;
  readonly name: string;
  readonly sent: number;
  readonly total: number;
}

const progress = new Map<string, UploadProgress>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, UploadProgress> = new Map();

function publish(): void {
  snapshot = new Map(progress);
  for (const listener of listeners) listener();
}

export function reportUploadProgress(messageId: string, next: UploadProgress | null): void {
  if (next === null) {
    if (!progress.delete(messageId)) return;
  } else {
    const current = progress.get(messageId);
    // A bar that moves less than half a percent is not redrawn.
    if (
      current !== undefined &&
      current.name === next.name &&
      next.sent !== next.total &&
      Math.abs(next.sent - current.sent) < next.total * 0.005
    ) {
      return;
    }
    progress.set(messageId, next);
  }
  publish();
}

export function useUploadProgress(): ReadonlyMap<string, UploadProgress> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
