import { createElement, type JSX } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useReportViewingThread, VIEWING_HEARTBEAT_MS } from "./useReportViewingThread";

const reports: Array<{ environmentId: string; threadId: string | null }> = [];

vi.mock("./usePersonalAutomation", () => ({ personalPushReportViewing: "report-viewing" }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => (value: { environmentId: string; input: { threadId: string | null } }) => {
    reports.push({ environmentId: value.environmentId, threadId: value.input.threadId });
    return Promise.resolve({ _tag: "Success" });
  },
}));

const ENVIRONMENT = EnvironmentId.make("test-env");
const THREAD = ThreadId.make("thread-1");

/** Stand-in document whose visibility the test drives. */
class FakeDocument extends EventTarget {
  visibilityState: "visible" | "hidden" = "visible";
}

describe("useReportViewingThread", () => {
  let renderer: ReactTestRenderer | null = null;
  let doc: FakeDocument;
  let heartbeats: Array<() => void>;
  let cleared: Array<number>;

  const Probe = ({
    threadId,
    connected,
  }: {
    threadId: ThreadId;
    connected: boolean;
  }): JSX.Element | null => {
    useReportViewingThread(ENVIRONMENT, threadId, connected);
    return null;
  };

  const render = (props: { threadId: ThreadId; connected: boolean }) => {
    act(() => {
      renderer = create(createElement(Probe, props));
    });
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    reports.length = 0;
    heartbeats = [];
    cleared = [];
    doc = new FakeDocument();
    const listeners = new Map<string, Set<() => void>>();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", {
      setInterval: (handler: () => void, ms: number) => {
        expect(ms).toBe(VIEWING_HEARTBEAT_MS);
        heartbeats.push(handler);
        return heartbeats.length;
      },
      clearInterval: (id: number) => cleared.push(id),
      addEventListener: (type: string, handler: () => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(handler);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, handler: () => void) => {
        listeners.get(type)?.delete(handler);
      },
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  it("reports the open chat, then stops reporting it while hidden", () => {
    render({ threadId: THREAD, connected: true });
    expect(reports).toEqual([{ environmentId: ENVIRONMENT, threadId: THREAD }]);

    act(() => {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    });
    expect(reports.at(-1)).toEqual({ environmentId: ENVIRONMENT, threadId: null });

    // Backgrounded: the heartbeat must not put the chat back on the server.
    act(() => heartbeats.forEach((tick) => tick()));
    expect(reports.at(-1)).toEqual({ environmentId: ENVIRONMENT, threadId: null });

    act(() => {
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => heartbeats.forEach((tick) => tick()));
    expect(reports.slice(-2)).toEqual([
      { environmentId: ENVIRONMENT, threadId: THREAD },
      { environmentId: ENVIRONMENT, threadId: THREAD },
    ]);
  });

  it("gives the chat up on unmount and moves presence to the next chat", () => {
    render({ threadId: THREAD, connected: true });
    const other = ThreadId.make("thread-2");
    act(() => {
      renderer?.update(createElement(Probe, { threadId: other, connected: true }));
    });
    // Leaving thread-1 releases it before thread-2 claims it.
    expect(reports).toEqual([
      { environmentId: ENVIRONMENT, threadId: THREAD },
      { environmentId: ENVIRONMENT, threadId: null },
      { environmentId: ENVIRONMENT, threadId: other },
    ]);
    expect(cleared.length).toBe(1);

    act(() => renderer?.unmount());
    renderer = null;
    expect(reports.at(-1)).toEqual({ environmentId: ENVIRONMENT, threadId: null });
  });

  it("reports nothing until the connection is up, then re-reports on reconnect", () => {
    render({ threadId: THREAD, connected: false });
    expect(reports).toEqual([]);

    act(() => {
      renderer?.update(createElement(Probe, { threadId: THREAD, connected: true }));
    });
    expect(reports).toEqual([{ environmentId: ENVIRONMENT, threadId: THREAD }]);

    // A drop and reconnect makes the new connection say what it is viewing.
    act(() => {
      renderer?.update(createElement(Probe, { threadId: THREAD, connected: false }));
    });
    act(() => {
      renderer?.update(createElement(Probe, { threadId: THREAD, connected: true }));
    });
    expect(reports.at(-1)).toEqual({ environmentId: ENVIRONMENT, threadId: THREAD });
  });
});
