import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { UpdateStatusLine } from "./UpdateStatusLine";
import {
  DISMISSED_LINE_KEY,
  getUpdateRestartSignal,
  resetUpdateRestartSignalForTesting,
  SEEN_UPDATED_KEY,
} from "./updateStatus";

const T0 = Date.parse("2026-10-12T21:00:00.000Z");

const state = vi.hoisted(() => ({
  environmentId: "env-1" as string | null,
  answered: 0,
  queue: [] as Array<"throw" | { status: number; body?: unknown }>,
}));

vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => state.environmentId,
}));

const answer = (phase: string, version = "1.66.34") => ({
  phase,
  version,
  previousVersion: "1.66.33",
  updatedAt: "2026-10-12T20:59:00.000Z",
});

let renderer: ReactTestRenderer | undefined;

const documentStub = {
  visibilityState: "visible" as string,
  listeners: new Set<() => void>(),
  addEventListener: (type: string, callback: () => void) => {
    if (type === "visibilitychange") documentStub.listeners.add(callback);
  },
  removeEventListener: (type: string, callback: () => void) => {
    documentStub.listeners.delete(callback);
  },
};

let stored = new Map<string, string>();

const stubGlobals = () => {
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
    removeItem: (key: string) => {
      stored.delete(key);
    },
    clear: () => stored.clear(),
  };
  vi.stubGlobal("window", {
    localStorage,
    setTimeout: (callback: () => void, ms?: number) => setTimeout(callback, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  });
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      state.answered += 1;
      const next = state.queue.shift();
      if (next === undefined || next === "throw") throw new TypeError("Failed to fetch");
      return new Response(next.body === undefined ? "bad" : JSON.stringify(next.body), {
        status: next.status,
      });
    }),
  );
};

/** Flushes the fetch chain: the request, the body and the state update. */
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
};

const render = async (versionLabel: string | null = "v1.66.33") => {
  await act(async () => {
    renderer = create(<UpdateStatusLine versionLabel={versionLabel} />);
  });
  await flush();
};

const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
};

const tree = () => JSON.stringify(renderer?.toJSON());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  state.environmentId = "env-1";
  state.answered = 0;
  state.queue = [];
  stored = new Map();
  documentStub.visibilityState = "visible";
  documentStub.listeners.clear();
  stubGlobals();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  resetUpdateRestartSignalForTesting();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the line under the header", () => {
  it("shows nothing, and takes no space, when no update is moving", async () => {
    state.queue.push({
      status: 200,
      body: { phase: null, version: null, previousVersion: null, updatedAt: null },
    });
    await render();
    expect(state.answered).toBe(1);
    const output = tree();
    // The row is collapsed to nothing - the list sits right under the header,
    // no reserved 16 px - and there are no words, only the empty region.
    expect(output).toContain('"aria-live":"polite"');
    expect(output).toContain("grid-rows-[0fr]");
    expect(output).not.toContain("grid-rows-[1fr]");
    expect(output).toContain('"inert":true');
    expect(output).not.toContain("update");
    expect(output).not.toContain("<button");
  });

  it("reads the phase the server is in, in an open row", async () => {
    state.queue.push({ status: 200, body: answer("waiting_for_idle") });
    await render();
    const output = tree();
    expect(output).toContain("Update 1.66.34 ready, installs when the bots are idle");
    expect(output).toContain("--personal-review-text");
    // One line, quiet: 12px, not a card and not a button while it is moving.
    expect(output).toContain("text-[12px]");
    // Real news opens the row (smoothly, in the browser) instead of staying
    // out of sight in a hidden slot.
    expect(output).toContain("grid-rows-[1fr]");
    expect(output).not.toContain("grid-rows-[0fr]");
    expect(output).not.toContain('"inert":true');
    expect(output).not.toContain("<button");
  });

  it("collapses the row when a moving phase goes away", async () => {
    state.queue.push({ status: 200, body: answer("backing_up") });
    await render();
    expect(tree()).toContain("Backing up before update");
    expect(tree()).toContain("grid-rows-[1fr]");
    state.queue.push({ status: 200, body: answer("superseded_before_activation") });
    await advance(10_000);
    // Collapsing: the row has no height, the words stay to fade with it.
    expect(tree()).toContain("grid-rows-[0fr]");
    expect(tree()).toContain('"inert":true');
    expect(tree()).toContain("Backing up before update");
    await advance(300);
    expect(tree()).not.toContain("Backing up before update");
  });

  it("says the server is restarting when it goes away with an update on its way", async () => {
    state.queue.push({ status: 200, body: answer("waiting_for_idle") });
    state.queue.push("throw");
    await render();
    await advance(10_000);
    expect(state.answered).toBe(2);
    const output = tree();
    expect(output).toContain("Restarting for update");
    expect(output).not.toContain("Update 1.66.34 ready");
  });

  it("tells the offline banner where the update stands, phase by phase", async () => {
    state.queue.push({ status: 200, body: answer("waiting_for_idle") });
    await render();
    // Armed, connected: the phase is known, no restarting words yet.
    expect(getUpdateRestartSignal().lastSeen?.phase).toBe("waiting_for_idle");
    expect(getUpdateRestartSignal().restartingSinceMs).toBeNull();
    state.queue.push("throw");
    await advance(10_000);
    // The server went away with the update on its way: the line reads
    // "Restarting for update" and the stamp starts at that moment.
    expect(tree()).toContain("Restarting for update");
    expect(getUpdateRestartSignal().lastSeen?.phase).toBe("waiting_for_idle");
    expect(getUpdateRestartSignal().restartingSinceMs).toBe(T0 + 10_000);
  });

  it("keeps a plain outage a plain outage when no update was on its way", async () => {
    state.queue.push({ status: 200, body: answer("live_verified") });
    state.queue.push("throw");
    await render();
    expect(tree()).toContain("Updated to 1.66.34");
    // Ten seconds end the one-time note; the collapse is still running here.
    await advance(10_000);
    expect(state.answered).toBe(2);
    expect(tree()).not.toContain("grid-rows-[1fr]");
    expect(tree()).not.toContain("Restarting for update");
    await advance(300);
    expect(tree()).not.toContain("Updated to");
  });

  it("shows Updated to x for ten seconds, once per version, then collapses it", async () => {
    state.queue.push({ status: 200, body: answer("live_verified") });
    state.queue.push({ status: 200, body: answer("live_verified") });
    await render();
    expect(tree()).toContain("Updated to 1.66.34");
    expect(tree()).toContain("grid-rows-[1fr]");
    // Remembered the moment it is shown: closing the app inside the ten
    // seconds does not bring the words back on the next launch.
    expect(stored.get(SEEN_UPDATED_KEY)).toContain("1.66.34");

    // Ten seconds: the row collapses, the words stay to fade with it.
    await advance(10_000);
    expect(tree()).not.toContain("grid-rows-[1fr]");
    expect(tree()).toContain("grid-rows-[0fr]");
    expect(tree()).toContain('"inert":true');
    expect(tree()).toContain("Updated to 1.66.34");
    // The poll that answered the same phase does not bring it back.
    await advance(300);
    expect(tree()).not.toContain("Updated to 1.66.34");

    // A fresh launch on the same device: the same version stays quiet.
    await act(async () => renderer?.unmount());
    state.queue.push({ status: 200, body: answer("live_verified") });
    await render();
    expect(tree()).not.toContain("Updated to 1.66.34");
    expect(tree()).toContain("grid-rows-[0fr]");
  });

  it("shows a newer version's note again", async () => {
    state.queue.push({ status: 200, body: answer("live_verified", "1.66.34") });
    await render();
    expect(tree()).toContain("Updated to 1.66.34");
    await act(async () => renderer?.unmount());
    state.queue.push({ status: 200, body: answer("live_verified", "1.66.35") });
    await render();
    expect(tree()).toContain("Updated to 1.66.35");
    expect(tree()).toContain("grid-rows-[1fr]");
  });

  it("lets a tap put the Updated line away early, and keeps it away next launch", async () => {
    state.queue.push({ status: 200, body: answer("live_verified") });
    await render();
    expect(tree()).toContain("Updated to 1.66.34");
    const button = renderer!.root.findByType("button");
    await act(async () => {
      button.props.onClick();
    });
    expect(tree()).toContain("grid-rows-[0fr]");
    expect(stored.get(SEEN_UPDATED_KEY)).toContain("1.66.34");
    await advance(300);
    expect(tree()).not.toContain("Updated to 1.66.34");

    // A fresh launch (a new mount, same device) with the same finished line:
    // still gone.
    await act(async () => renderer?.unmount());
    state.queue.push({ status: 200, body: answer("live_verified") });
    await render();
    expect(tree()).not.toContain("Updated to 1.66.34");
  });

  it("keeps a tapped failure line away with the 24-hour dismissal memory", async () => {
    state.queue.push({ status: 200, body: answer("rolled_back") });
    await render();
    expect(tree()).toContain("Update failed, still on 1.66.33");
    const button = renderer!.root.findByType("button");
    await act(async () => {
      button.props.onClick();
    });
    expect(tree()).toContain("grid-rows-[0fr]");
    // The failure memory, not the seen-version one: a failure is not a
    // once-per-version note.
    expect(stored.get(DISMISSED_LINE_KEY)).toContain("rolled_back");
    expect(stored.get(SEEN_UPDATED_KEY)).toBeUndefined();

    await advance(300);
    expect(tree()).not.toContain("Update failed");
    await act(async () => renderer?.unmount());
    state.queue.push({ status: 200, body: answer("rolled_back") });
    await render();
    expect(tree()).not.toContain("Update failed");
  });

  it("shows a failed landing with what is still live", async () => {
    state.queue.push({ status: 200, body: { ...answer("rolled_back"), previousVersion: null } });
    await render();
    expect(tree()).toContain("Update failed, still on 1.66.33");
    expect(tree()).toContain("--personal-danger");
  });

  it("asks only while the page is visible, and at once when it comes back", async () => {
    documentStub.visibilityState = "hidden";
    await render();
    expect(state.answered).toBe(0);
    documentStub.visibilityState = "visible";
    state.queue.push({ status: 200, body: answer("backing_up") });
    await act(async () => {
      for (const listener of documentStub.listeners) listener();
    });
    await flush();
    expect(state.answered).toBe(1);
    expect(tree()).toContain("Backing up before update");
  });

  it("does not ask at all before the laptop is paired", async () => {
    state.environmentId = null;
    await render();
    expect(state.answered).toBe(0);
  });
});
