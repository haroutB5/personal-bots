// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDateInEffect:off
/**
 * The usage ledger against real dsh session-log bytes.
 *
 * The fixture is a session log from the 13 Oct probe run
 * (`design/hbots/dsh-harness/probe/out/`), re-encoded here the way dsh writes
 * it: a concatenation of independently compressed zstd frames, one per event.
 */
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  appendDshLedgerLines,
  decodeDshSessionFrames,
  dshSessionFilePath,
  dshStepToTranscriptLine,
  dshUsageDir,
  findDshDescendantSessions,
  parseDshAssistantStep,
  parseDshSessionHeader,
  readDshSessionBytes,
  readLedgerLastSeq,
} from "./dshUsageLedger.ts";

const layer = NodeServices.layer;

it.layer(layer)("dshUsageLedger", (it) => {
  const SESSION_ID = "72e81833-6ccb-439a-a2eb-0720d5712684";
  const CWD = "C:\\Users\\Ht\\.personal-bots\\qa\\dsh-harness\\probe\\work";

  /** One dsh event as its own zstd frame, exactly as the agent appends them. */
  const frame = (
    event: Record<string, unknown>,
    options?: { readonly checksum?: boolean },
  ): Buffer =>
    NodeZlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, "utf8"), {
      ...(options?.checksum === true
        ? { params: { [NodeZlib.constants.ZSTD_c_checksumFlag]: 1 } }
        : {}),
    });

  const header = {
    type: "session",
    version: 4,
    id: SESSION_ID,
    createdAt: 1791917105872,
    cwd: CWD,
    isSeeded: false,
    delegationDepth: 0,
  };

  const step = (seq: number, messageId: string, usage: Record<string, number>) => ({
    type: "assistant/message",
    seq,
    time: 1791917108068 + seq,
    data: {
      turn: 1,
      step: seq,
      message: {
        role: "assistant",
        content: [],
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" },
        id: messageId,
      },
      usage,
    },
  });

  const usage = { inputTokens: 5896, outputTokens: 4, cacheReadTokens: 128, cacheWriteTokens: 0 };

  const writeSession = (
    dshHome: string,
    frames: ReadonlyArray<Buffer>,
  ): { readonly file: string } => {
    const folder = `--${CWD.replace(/[\\/:]/g, "-")}--`;
    const file = NodePathJoin(dshHome, "sessions", folder, SESSION_ID, "session.v4.jsonl.zstd");
    NodeFS.mkdirSync(NodePathDirname(file), { recursive: true });
    NodeFS.writeFileSync(file, Buffer.concat([...frames]));
    return { file };
  };

  // Kept local so this file's only Node imports are the two above.
  const NodePathJoin = (...parts: string[]): string => parts.join("/");
  const NodePathDirname = (file: string): string => file.slice(0, file.lastIndexOf("/"));

  it.effect("decodes whole frames and holds the offset at a half-written one", () =>
    Effect.sync(() => {
      const complete = Buffer.concat([frame(header), frame(step(1, "m1", usage))]);
      const first = decodeDshSessionFrames(complete, 0);
      expect(first.lines).toHaveLength(2);
      expect(first.offset).toBe(complete.length);
      // A tail still being written does not advance the offset, so the next read
      // sees those bytes again rather than losing them.
      const torn = Buffer.concat([complete, frame(step(2, "m2", usage)).subarray(0, 12)]);
      const second = decodeDshSessionFrames(torn, first.offset);
      expect(second.lines).toEqual([]);
      expect(second.offset).toBe(first.offset);
      // Once the frame is whole, it decodes from exactly that offset.
      const whole = Buffer.concat([complete, frame(step(2, "m2", usage))]);
      const third = decodeDshSessionFrames(whole, first.offset);
      expect(third.lines).toHaveLength(1);
      expect(parseDshAssistantStep(third.lines[0]!)).toMatchObject({
        seq: 2,
        messageId: "m2",
        model: "deepseek-flash",
        inputTokens: 5896,
        cacheReadTokens: 128,
      });
    }),
  );

  it.effect("decodes the zstd checksum dsh writes on every frame", () =>
    Effect.sync(() => {
      // dsh's writer enables the frame checksum; a decoder that stops at the
      // last block cuts four bytes off and zstd refuses the frame (the bug
      // that silently emptied the usage ledger on 25 Oct).
      const headerFrame = frame(header, { checksum: true });
      const stepFrame = frame(step(1, "m1", usage), { checksum: true });
      const complete = Buffer.concat([headerFrame, stepFrame]);
      const decoded = decodeDshSessionFrames(complete, 0);
      expect(decoded.lines).toHaveLength(2);
      expect(decoded.offset).toBe(complete.length);
      expect(parseDshSessionHeader(decoded.lines[0]!)).toEqual({ id: SESSION_ID });
      expect(parseDshAssistantStep(decoded.lines[1]!)).toMatchObject({ seq: 1, messageId: "m1" });
      // A frame whose checksum has not arrived is held, not lost.
      const torn = Buffer.concat([headerFrame, stepFrame.subarray(0, stepFrame.length - 4)]);
      const held = decodeDshSessionFrames(torn, 0);
      expect(held.lines).toHaveLength(1);
      expect(held.offset).toBe(headerFrame.length);
    }),
  );

  it.effect("reads the session header, parent included", () =>
    Effect.sync(() => {
      expect(parseDshSessionHeader(JSON.stringify(header))).toEqual({ id: SESSION_ID });
      expect(
        parseDshSessionHeader(
          JSON.stringify({ ...header, id: "child-1", parentSession: SESSION_ID }),
        ),
      ).toEqual({ id: "child-1", parentSession: SESSION_ID });
      expect(parseDshSessionHeader(JSON.stringify({ type: "turn/start" }))).toBeNull();
      expect(parseDshSessionHeader("not json")).toBeNull();
    }),
  );

  it.effect("writes the Claude shape the usage scan already reads", () =>
    Effect.sync(() => {
      const parsed = parseDshAssistantStep(JSON.stringify(step(15, "6d7c3f37", usage)))!;
      const line = JSON.parse(
        dshStepToTranscriptLine({ step: parsed, rootSessionId: SESSION_ID }),
      ) as Record<string, unknown>;
      expect(line.type).toBe("assistant");
      expect(line.sessionId).toBe(SESSION_ID);
      expect(line.requestId).toBe(`${SESSION_ID}:15`);
      expect(line.timestamp).toBe(new Date(1791917108068 + 15).toISOString());
      expect(line.message).toEqual({
        id: "6d7c3f37",
        model: "deepseek-flash",
        usage: {
          input_tokens: 5896,
          output_tokens: 4,
          cache_read_input_tokens: 128,
          cache_creation_input_tokens: 0,
        },
      });
      // Anything that is not a committed assistant step is skipped.
      expect(parseDshAssistantStep(JSON.stringify({ type: "turn/end", seq: 1 }))).toBeNull();
      expect(parseDshAssistantStep("nope")).toBeNull();
    }),
  );

  it.effect("finds the session file, appends to the ledger and resumes from its last seq", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dshHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-ledger-" });
      writeSession(dshHome, [
        frame(header),
        frame(step(1, "m1", usage)),
        frame(step(2, "m2", usage)),
      ]);
      const file = dshSessionFilePath(dshHome, SESSION_ID);
      expect(file).toBeDefined();
      const bytes = readDshSessionBytes(file!);
      expect(bytes).toBeDefined();
      const decoded = decodeDshSessionFrames(bytes!, 0);
      const lines = decoded.lines
        .map((line) => parseDshAssistantStep(line))
        .filter((parsed) => parsed !== null)
        .map((parsed) => dshStepToTranscriptLine({ step: parsed, rootSessionId: SESSION_ID }));
      expect(lines).toHaveLength(2);
      const ledgerPath = path.join(dshUsageDir(dshHome), `${SESSION_ID}.jsonl`);
      expect(appendDshLedgerLines(ledgerPath, lines)).toBe(2);
      expect(readLedgerLastSeq(ledgerPath, SESSION_ID)).toBe(2);
      // A second pass over the same bytes writes nothing new, so a restart can
      // never bill a step twice.
      expect(
        decoded.lines
          .map((line) => parseDshAssistantStep(line))
          .filter(
            (parsed) => parsed !== null && parsed.seq > readLedgerLastSeq(ledgerPath, SESSION_ID),
          ),
      ).toEqual([]);
      expect(readLedgerLastSeq(ledgerPath, "another-session")).toBe(-1);
      expect(dshSessionFilePath(dshHome, "missing-session")).toBeUndefined();
      expect(appendDshLedgerLines(ledgerPath, [])).toBe(0);
    }),
  );

  it.effect("picks up a subagent session that names this one as its parent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dshHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dsh-desc-" });
      writeSession(dshHome, [frame(header), frame(step(1, "m1", usage))]);
      const file = dshSessionFilePath(dshHome, SESSION_ID)!;
      // The workspace folder, one level above the session's own directory: dsh
      // logs every session of a workspace side by side there.
      const folder = path.dirname(path.dirname(file));
      const writeSibling = (name: string, parent: string) => {
        const dir = path.join(folder, name);
        NodeFS.mkdirSync(dir, { recursive: true });
        NodeFS.writeFileSync(
          path.join(dir, "session.v4.jsonl.zstd"),
          frame({ ...header, id: name, parentSession: parent }),
        );
      };
      writeSibling("child-session-1", SESSION_ID);
      writeSibling("unrelated-session", "someone-else");
      const found = findDshDescendantSessions({
        dshHome,
        rootSessionId: SESSION_ID,
        sessionFilePath: file,
        alreadyKnown: new Set<string>(),
      });
      expect(found.map((entry) => entry.sessionId)).toEqual(["child-session-1"]);
      // Already-classified sessions are not re-read.
      const again = findDshDescendantSessions({
        dshHome,
        rootSessionId: SESSION_ID,
        sessionFilePath: file,
        alreadyKnown: new Set([SESSION_ID, "child-session-1", "unrelated-session"]),
      });
      expect(again).toEqual([]);
    }),
  );
});
