/**
 * One-time cleanup for the retired ordered typing rounds (1.66.26, removed in
 * 1.66.27). Round 2 flipped the composer re-pin kill switch by merging
 * "resize-pin-tween" into `bots:perf-off`, remembering the exact original
 * string in the `bots:typejump-restore` session marker so it could put it back.
 * The recorder that owned both is gone, so a phone killed mid-round would keep
 * a flipped (and now meaningless) entry forever. Applied once at app startup
 * (PersonalShell), then the marker is dropped.
 *
 * The marker format is the retired recorder's: `{"present":bool,"value":string}`.
 * `value` is the owner's own string, so it is restored as it was, not rebuilt.
 */
import { PERF_OFF_STORAGE_KEY } from "./perfFlags";

const RESTORE_MARKER_KEY = "bots:typejump-restore";
const TWEEN_OFF_ENTRY = "resize-pin-tween";

/** Applies a leftover round-2 flip, if one is remembered. Safe on every load. */
export function restoreTypeJumpPerfFlag(): void {
  let storage: Storage | undefined;
  let marker: Storage | undefined;
  let raw: string | null = null;
  try {
    storage = globalThis.localStorage;
    marker = globalThis.sessionStorage;
    if (storage === undefined || marker === undefined) return;
    raw = marker.getItem(RESTORE_MARKER_KEY);
  } catch {
    // Unreadable storage: nothing to restore here.
    return;
  }
  if (raw === null) return;
  try {
    const saved = JSON.parse(raw) as { present?: boolean; value?: string };
    if (saved.present === true && typeof saved.value === "string") {
      storage.setItem(PERF_OFF_STORAGE_KEY, saved.value);
    } else {
      storage.removeItem(PERF_OFF_STORAGE_KEY);
    }
  } catch {
    // A marker that cannot be parsed or applied: drop the entry the round-2
    // flip added, so no phone keeps a switch this build does not have.
    dropTweenEntry(storage);
  }
  try {
    marker.removeItem(RESTORE_MARKER_KEY);
  } catch {
    // The marker is left for the next load rather than throwing at startup.
  }
}

/** Removes "resize-pin-tween" from `bots:perf-off`, keeping every other entry. */
function dropTweenEntry(storage: Storage): void {
  try {
    const current = storage.getItem(PERF_OFF_STORAGE_KEY);
    if (current === null) return;
    const kept = current
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry !== TWEEN_OFF_ENTRY);
    if (kept.length === 0) storage.removeItem(PERF_OFF_STORAGE_KEY);
    else storage.setItem(PERF_OFF_STORAGE_KEY, kept.join(","));
  } catch {
    // Nothing else to try: the entry only ever turned a switch off.
  }
}
