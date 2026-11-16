/**
 * The row press and the open that follows, against a real node HTTP server on an ephemeral port:
 * the real press hook, the real saved-copy check and the real loader. Only the expo native modules
 * are stubbed. Counts what the server received.
 */
import { ThreadId } from "@t3tools/contracts";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const files = vi.hoisted(() => new Set<string>());

vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-crypto", () => ({}));
vi.mock("../platform/secureStorage", () => ({
  writeEncryptedText: async () => undefined,
  readDecryptedText: async () => null,
}));
vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(parent: { uri: string } | string, name: string) {
      this.uri = `${typeof parent === "string" ? parent : parent.uri}/${name}`;
    }
    get exists() {
      return true;
    }
    create() {}
  }
  class File {
    readonly uri: string;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
    get exists() {
      return files.has(this.uri);
    }
  }
  return { Directory, File, Paths: { document: "file:///documents" } };
});

import serverBody from "./fixtures/boundedThreadSnapshot.json";
import { setPerfOff, resetPerfOffForTest } from "../perfFlags";
import { takeChatOpenReport } from "./chatOpenPerf";
import { holdChat, takeChatTap } from "./chatOpenIntent";
import { onChatPress } from "./chatPress";
import {
  loadThreadSnapshot,
  threadSnapshotLoader,
} from "./threadSnapshotLoader";
import type { StoredSession } from "../session";

interface Lab {
  readonly server: Server;
  readonly base: string;
  readonly log: Array<{ url: string; authorization: string | undefined }>;
  mode: "ok" | "503" | "404" | "hang" | "failfirst";
  sequence: number;
}

const labs: Lab[] = [];
async function startLab(sequence = 46): Promise<Lab> {
  const log: Lab["log"] = [];
  const lab = { log, mode: "ok", sequence } as Lab;
  const server = createServer((req: IncomingMessage, res) => {
    log.push({ url: req.url ?? "", authorization: req.headers.authorization });
    if (lab.mode === "hang") return;
    if (lab.mode === "503" || (lab.mode === "failfirst" && log.length === 1)) {
      res.statusCode = 503;
      res.end();
      return;
    }
    if (lab.mode === "404") {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...serverBody, snapshotSequence: lab.sequence }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(lab, { server, base });
  labs.push(lab);
  return lab;
}

const session = (lab: Lab, token = "t"): StoredSession => ({
  environmentId: "environment-phone",
  label: "Lab",
  httpBaseUrl: lab.base,
  wsBaseUrl: lab.base.replace("http", "ws"),
  accessToken: token,
  authMethod: "bearer",
  scope: "",
  expiresAt: 0,
  pairedAt: 0,
});

let counter = 0;
let A = ThreadId.make("a-0");
let B = ThreadId.make("b-0");
const settle = () => new Promise((done) => setTimeout(done, 60));

afterEach(async () => {
  resetPerfOffForTest();
  files.clear();
  vi.restoreAllMocks();
  for (const lab of labs.splice(0)) {
    lab.server.closeAllConnections();
    await new Promise((done) => lab.server.close(done));
  }
});

beforeEach(() => {
  resetPerfOffForTest();
  counter += 1;
  A = ThreadId.make(`aaaaaaaa-0000-4000-8000-${String(counter).padStart(12, "0")}`);
  B = ThreadId.make(`bbbbbbbb-0000-4000-8000-${String(counter).padStart(12, "0")}`);
});

describe("requests sent by a press and the open after it", () => {
  it("network path: press then mount is exactly one request", async () => {
    const lab = await startLab();
    const stored = session(lab);
    threadSnapshotLoader(stored);
    onChatPress(A);
    const result = await loadThreadSnapshot(stored, A);
    await settle();
    expect(result._tag).toBe("present");
    expect(lab.log.map((entry) => entry.url.split("?")[0])).toEqual([
      `/api/orchestration/threads/${A}/bounded`,
    ]);
  });

  it("network path with the switch off: press asks nobody, mount asks once, same request shape", async () => {
    const lab = await startLab();
    const stored = session(lab);
    threadSnapshotLoader(stored);
    onChatPress(A);
    await loadThreadSnapshot(stored, A);
    const withSwitchOn = lab.log.splice(0);

    setPerfOff(["android-preload-chat"]);
    threadSnapshotLoader(stored);
    onChatPress(A);
    await settle();
    expect(lab.log).toHaveLength(0);
    await loadThreadSnapshot(stored, A);
    expect(lab.log).toHaveLength(1);
    expect(lab.log[0]).toEqual(withSwitchOn[0]);
  });

  it("memory path (chat held by the screen): press asks nobody", async () => {
    const lab = await startLab();
    const stored = session(lab);
    threadSnapshotLoader(stored);
    const release = holdChat(A);
    onChatPress(A);
    release();
    onChatPress(A);
    await settle();
    expect(lab.log).toHaveLength(0);
  });

  it("cache path (saved copy file exists): press asks nobody, through the real hasCachedThread", async () => {
    const lab = await startLab();
    const stored = session(lab);
    threadSnapshotLoader(stored);
    files.add(`file:///documents/hbots-thread-cache/thread-environment-phone-${A}.json`);
    onChatPress(A);
    await settle();
    expect(lab.log).toHaveLength(0);
  });

  it("two rows: the first request is not cancelled and is wasted when only the second chat opens", async () => {
    const lab = await startLab();
    const stored = session(lab);
    threadSnapshotLoader(stored);
    onChatPress(A);
    onChatPress(B);
    await loadThreadSnapshot(stored, B);
    await settle();
    expect(lab.log.map((entry) => entry.url.split("/")[4])).toEqual([A, B]);
  });

  it("a double tap on one row is one request", async () => {
    const lab = await startLab();
    const stored = session(lab);
    threadSnapshotLoader(stored);
    onChatPress(A);
    onChatPress(A);
    await loadThreadSnapshot(stored, A);
    await settle();
    expect(lab.log).toHaveLength(1);
  });
});

describe("a prefetch under a wrong session, a failure or a stale clock", () => {
  it("a prefetch made under session 1 is not given to session 2 (account or server switch)", async () => {
    const first = await startLab(11);
    const second = await startLab(22);
    const s1 = session(first, "token-one");
    threadSnapshotLoader(s1);
    onChatPress(A);
    await settle();
    expect(first.log).toHaveLength(1);

    const s2 = session(second, "token-two");
    threadSnapshotLoader(s2);
    const result = await loadThreadSnapshot(s2, A);
    expect(second.log).toHaveLength(1);
    expect(second.log[0]!.authorization).toBe("Bearer token-two");
    if (result._tag !== "present") throw new Error("expected present");
    expect(result.snapshot.snapshotSequence).toBe(22);
  });

  it("a stale loader call with the OLD session object after a switch does not take the new session's prefetch", async () => {
    const first = await startLab(11);
    const second = await startLab(22);
    const s1 = session(first, "token-one");
    const s2 = session(second, "token-two");
    threadSnapshotLoader(s1);
    threadSnapshotLoader(s2);
    onChatPress(A);
    await settle();
    expect(second.log).toHaveLength(1);
    const result = await loadThreadSnapshot(s1, A);
    expect(first.log).toHaveLength(1);
    if (result._tag !== "present") throw new Error("expected present");
    expect(result.snapshot.snapshotSequence).toBe(11);
  });

  it("a failed prefetch (503) is retried by the open: two requests, and the open still succeeds", async () => {
    const lab = await startLab();
    lab.mode = "failfirst";
    const stored = session(lab);
    threadSnapshotLoader(stored);
    onChatPress(A);
    const result = await loadThreadSnapshot(stored, A);
    expect(result._tag).toBe("present");
    expect(lab.log).toHaveLength(2);
  });

  it("a failed prefetch does not poison the NEXT open: the next open after it asks fresh", async () => {
    const lab = await startLab();
    lab.mode = "503";
    const stored = session(lab);
    threadSnapshotLoader(stored);
    onChatPress(A);
    await loadThreadSnapshot(stored, A);
    lab.log.splice(0);
    lab.mode = "ok";
    const result = await loadThreadSnapshot(stored, A);
    expect(result._tag).toBe("present");
    expect(lab.log).toHaveLength(1);
  });

  it("a 404 chat (deleted) costs two requests, the prefetch and the open's own", async () => {
    const lab = await startLab();
    lab.mode = "404";
    const stored = session(lab);
    threadSnapshotLoader(stored);
    onChatPress(A);
    const result = await loadThreadSnapshot(stored, A);
    expect(result._tag).toBe("missing");
    expect(lab.log).toHaveLength(2);
  });

  it("lets a hung prefetch hang the open as long as the old single request would", async () => {
    const lab = await startLab();
    lab.mode = "hang";
    const stored = session(lab);
    threadSnapshotLoader(stored);
    onChatPress(A);
    let settled = false;
    void loadThreadSnapshot(stored, A).then(() => {
      settled = true;
    });
    await new Promise((done) => setTimeout(done, 1500));
    expect(settled).toBe(false);
    expect(lab.log).toHaveLength(1);
  });

  it("an unconsumed prefetch is not handed to a much later open: the open asks again", async () => {
    const lab = await startLab();
    const stored = session(lab);
    threadSnapshotLoader(stored);
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(1_000);
    onChatPress(A);
    await settle();
    clock.mockReturnValue(1_000 + 5_001);
    await loadThreadSnapshot(stored, A);
    expect(lab.log).toHaveLength(2);
  });
});

describe("the open beacon after a prefetch (current behaviour, D4 of the review)", () => {
  it("reports prefetched true, requestAtMs 0 and no responseMs after a failed prefetch, with fromTapMs covering both requests", async () => {
    const lab = await startLab();
    lab.mode = "failfirst";
    const stored = session(lab);
    threadSnapshotLoader(stored);
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(10_000);
    onChatPress(A);
    await settle();
    clock.mockReturnValue(10_250);
    const openedAt = 10_250;
    const result = await loadThreadSnapshot(stored, A);
    expect(result._tag).toBe("present");
    clock.mockReturnValue(10_700);
    const tapAt = takeChatTap(A, openedAt);
    const report = takeChatOpenReport(A, openedAt, 10_700, tapAt);
    expect(report.body.prefetched).toBe(true);
    expect(report.body.responseMs).toBeUndefined();
    expect(report.body.fromTapMs).toBe(700);
    expect(report.body.ms).toBe(450);
  });

  it("a prefetch that succeeded reports prefetched:true with response and decode times", async () => {
    const lab = await startLab();
    const stored = session(lab);
    threadSnapshotLoader(stored);
    onChatPress(A);
    await settle();
    const openedAt = performance.now();
    await loadThreadSnapshot(stored, A);
    const tapAt = takeChatTap(A, openedAt);
    const report = takeChatOpenReport(A, openedAt, performance.now() + 5, tapAt);
    expect(report.body.prefetched).toBe(true);
    expect(typeof report.body.responseMs).toBe("number");
    expect(report.body.store).toBe("network");
  });

  it("reports a prefetch nobody consumed as the next open's network request, though no load ran", async () => {
    const lab = await startLab();
    const stored = session(lab);
    threadSnapshotLoader(stored);
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(20_000);
    onChatPress(A);
    await settle();
    clock.mockReturnValue(20_200);
    const tapAt = takeChatTap(A, 20_200);
    const report = takeChatOpenReport(A, 20_200, 20_300, tapAt);
    expect(report.body.store).toBe("network");
  });
});
