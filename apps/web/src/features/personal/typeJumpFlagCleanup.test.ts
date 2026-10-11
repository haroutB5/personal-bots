/**
 * The retired typing-rounds recorder (1.66.26) flipped `bots:perf-off` for its
 * second round and left the owner's original string in the
 * `bots:typejump-restore` session marker. 1.66.27 removes the recorder, so this
 * cleanup puts a leftover flip back at startup. The marker format is the
 * recorder's own: `{"present":bool,"value":string}`.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { restoreTypeJumpPerfFlag } from "./typeJumpFlagCleanup";

const PERF_OFF = "bots:perf-off";
const MARKER = "bots:typejump-restore";

function fakeStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  const sets: Array<[string, string]> = [];
  const removes: string[] = [];
  return {
    map,
    sets,
    removes,
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        sets.push([key, value]);
        map.set(key, value);
      },
      removeItem: (key: string) => {
        removes.push(key);
        map.delete(key);
      },
    },
  };
}

function install(
  local: Record<string, string> = {},
  session: Record<string, string> = {},
): { local: ReturnType<typeof fakeStorage>; session: ReturnType<typeof fakeStorage> } {
  const localFake = fakeStorage(local);
  const sessionFake = fakeStorage(session);
  vi.stubGlobal("localStorage", localFake.storage);
  vi.stubGlobal("sessionStorage", sessionFake.storage);
  return { local: localFake, session: sessionFake };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("restoreTypeJumpPerfFlag", () => {
  it("does nothing when no round-2 flip was left behind", () => {
    const { local } = install({ [PERF_OFF]: "keep-list" });
    restoreTypeJumpPerfFlag();
    expect(local.sets).toEqual([]);
    expect(local.removes).toEqual([]);
    expect(local.map.get(PERF_OFF)).toBe("keep-list");
  });

  it("puts the owner's own string back, exactly as it was", () => {
    const { local, session } = install(
      { [PERF_OFF]: "wheel-batch,resize-pin-tween" },
      { [MARKER]: JSON.stringify({ present: true, value: "wheel-batch" }) },
    );
    restoreTypeJumpPerfFlag();
    expect(local.map.get(PERF_OFF)).toBe("wheel-batch");
    expect(session.map.has(MARKER)).toBe(false);
  });

  it("removes the key again when there was no string before the flip", () => {
    const { local, session } = install(
      { [PERF_OFF]: "resize-pin-tween" },
      { [MARKER]: JSON.stringify({ present: false, value: "" }) },
    );
    restoreTypeJumpPerfFlag();
    expect(local.map.has(PERF_OFF)).toBe(false);
    expect(session.map.has(MARKER)).toBe(false);
  });

  it("drops only the retired entry when the marker cannot be read", () => {
    const { local, session } = install(
      { [PERF_OFF]: "keep-list, resize-pin-tween ,anim-comet" },
      { [MARKER]: "{not json" },
    );
    restoreTypeJumpPerfFlag();
    expect(local.map.get(PERF_OFF)).toBe("keep-list,anim-comet");
    expect(session.map.has(MARKER)).toBe(false);
  });

  it("removes the key when the unreadable marker held only the retired entry", () => {
    const { local } = install({ [PERF_OFF]: "resize-pin-tween" }, { [MARKER]: "broken" });
    restoreTypeJumpPerfFlag();
    expect(local.map.has(PERF_OFF)).toBe(false);
  });

  it("is a no-op with no storage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    vi.stubGlobal("sessionStorage", undefined);
    expect(() => restoreTypeJumpPerfFlag()).not.toThrow();
  });
});
