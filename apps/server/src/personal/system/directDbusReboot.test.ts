// @effect-diagnostics nodeBuiltinImport:off - Tests the pure-Node D-Bus wire client against a real local Unix domain socket mock.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { directDbusCanReboot, directDbusReboot, tryDecodeDbusFrame } from "./directDbusReboot.ts";

const alignUp = (n: number, a: number) => (n % a === 0 ? n : n + (a - (n % a)));

interface MockFrameSpec {
  readonly littleEndian?: boolean;
  readonly msgType: number;
  readonly serial: number;
  readonly replySerial?: number;
  readonly errorName?: string;
  readonly signature?: string;
  readonly bodyString?: string;
}

function buildDbusFrame(spec: MockFrameSpec): Buffer {
  const le = spec.littleEndian ?? true;
  const writeU32 = (buf: Buffer, val: number, off: number) =>
    le ? buf.writeUInt32LE(val, off) : buf.writeUInt32BE(val, off);

  let body = Buffer.alloc(0);
  if (spec.bodyString !== undefined) {
    const strBytes = Buffer.from(spec.bodyString, "utf8");
    body = Buffer.alloc(4 + strBytes.length + 1);
    writeU32(body, strBytes.length, 0);
    strBytes.copy(body, 4);
    body[4 + strBytes.length] = 0;
  }

  const fieldChunks: Buffer[] = [];
  let offset = 16;
  const padTo8 = () => {
    const next = alignUp(offset, 8);
    if (next > offset) fieldChunks.push(Buffer.alloc(next - offset));
    offset = next;
  };

  if (spec.replySerial !== undefined) {
    padTo8();
    const b = Buffer.alloc(8);
    b[0] = 5; // REPLY_SERIAL
    b[1] = 1;
    b[2] = "u".charCodeAt(0);
    b[3] = 0;
    writeU32(b, spec.replySerial, 4);
    fieldChunks.push(b);
    offset += 8;
  }

  if (spec.errorName !== undefined) {
    padTo8();
    const bytes = Buffer.from(spec.errorName, "utf8");
    const prefix = Buffer.alloc(8);
    prefix[0] = 4; // ERROR_NAME
    prefix[1] = 1;
    prefix[2] = "s".charCodeAt(0);
    prefix[3] = 0;
    writeU32(prefix, bytes.length, 4);
    fieldChunks.push(prefix, bytes, Buffer.from([0]));
    offset += 8 + bytes.length + 1;
  }

  if (spec.signature !== undefined) {
    padTo8();
    const bytes = Buffer.from(spec.signature, "ascii");
    const prefix = Buffer.alloc(5);
    prefix[0] = 8; // SIGNATURE
    prefix[1] = 1;
    prefix[2] = "g".charCodeAt(0);
    prefix[3] = 0;
    prefix[4] = bytes.length;
    fieldChunks.push(prefix, bytes, Buffer.from([0]));
    offset += 5 + bytes.length + 1;
  }

  const fieldsLen = offset - 16;
  const headerTotal = alignUp(offset, 8);
  const padBytes = headerTotal - offset;

  const fixed = Buffer.alloc(16);
  fixed[0] = le ? 0x6c : 0x42; // 'l' or 'B'
  fixed[1] = spec.msgType;
  fixed[2] = 0;
  fixed[3] = 1;
  writeU32(fixed, body.length, 4);
  writeU32(fixed, spec.serial, 8);
  writeU32(fixed, fieldsLen, 12);

  return Buffer.concat([fixed, ...fieldChunks, Buffer.alloc(padBytes), body]);
}

interface MockServerOptions {
  readonly littleEndian?: boolean;
  readonly authReject?: boolean;
  readonly sendSignalBeforeReply?: boolean;
  readonly canRebootAnswer?: string;
  readonly errorOnCall?: { readonly name: string; readonly message: string };
  readonly stallAfterAuth?: boolean;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function startMockDbusServer(options: MockServerOptions = {}) {
  const dir = NodeFS.mkdtempSync("/tmp/hbots-dbus-");
  const socketPath = NodePath.join(dir, "bus.sock");
  const receivedCalls: Array<{ serial: number; body: Buffer; signature: string | null }> = [];
  let receivedAuthLine = "";

  const server = NodeNet.createServer((socket) => {
    let phase: "auth" | "begin" | "binary" = "auth";
    let buf = Buffer.alloc(0);
    let replySerialCounter = 100;

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (phase === "auth") {
          const nl = buf.indexOf("\r\n");
          if (nl === -1) return;
          const line = buf.subarray(0, nl).toString("ascii");
          buf = buf.subarray(nl + 2);
          receivedAuthLine = line;
          if (options.authReject) {
            socket.write("REJECTED EXTERNAL\r\n");
            return;
          }
          socket.write("OK 0123456789abcdef0123456789abcdef\r\n");
          phase = "begin";
          continue;
        }
        if (phase === "begin") {
          const nl = buf.indexOf("\r\n");
          if (nl === -1) return;
          buf = buf.subarray(nl + 2);
          phase = "binary";
          continue;
        }
        if (options.stallAfterAuth) return;

        const frame = tryDecodeDbusFrame(buf);
        if (frame === null) return;
        buf = buf.subarray(frame.totalBytes);
        receivedCalls.push({
          serial: frame.serial,
          body: frame.body,
          signature: frame.signature,
        });

        const le = options.littleEndian ?? true;
        // First call is always Hello (serial 1).
        if (frame.serial === 1) {
          socket.write(
            buildDbusFrame({
              littleEndian: le,
              msgType: 2,
              serial: replySerialCounter++,
              replySerial: frame.serial,
              signature: "s",
              bodyString: ":1.42",
            }),
          );
          continue;
        }

        if (options.sendSignalBeforeReply) {
          socket.write(
            buildDbusFrame({
              littleEndian: le,
              msgType: 4, // SIGNAL
              serial: replySerialCounter++,
              signature: "s",
              bodyString: ":1.42",
            }),
          );
        }

        if (options.errorOnCall) {
          socket.write(
            buildDbusFrame({
              littleEndian: le,
              msgType: 3, // ERROR
              serial: replySerialCounter++,
              replySerial: frame.serial,
              errorName: options.errorOnCall.name,
              signature: "s",
              bodyString: options.errorOnCall.message,
            }),
          );
          continue;
        }

        if (frame.signature === "b") {
          // Reboot(false) returns empty METHOD_RETURN
          socket.write(
            buildDbusFrame({
              littleEndian: le,
              msgType: 2,
              serial: replySerialCounter++,
              replySerial: frame.serial,
            }),
          );
        } else {
          // CanReboot returns string
          socket.write(
            buildDbusFrame({
              littleEndian: le,
              msgType: 2,
              serial: replySerialCounter++,
              replySerial: frame.serial,
              signature: "s",
              bodyString: options.canRebootAnswer ?? "yes",
            }),
          );
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  return {
    socketPath,
    receivedCalls,
    getReceivedAuthLine: () => receivedAuthLine,
  };
}

describe("directDbusReboot", () => {
  it("authenticates with NUL + hex(uid) and reads CanReboot in little-endian", async () => {
    const srv = await startMockDbusServer({ canRebootAnswer: "yes" });
    const res = await directDbusCanReboot({ socketPath: srv.socketPath, uid: 1000 });
    expect(res).toEqual({ ok: true, answer: "yes" });
    expect(srv.getReceivedAuthLine()).toBe("\0AUTH EXTERNAL 31303030");
    expect(srv.receivedCalls).toHaveLength(2);
  });

  it("handles big-endian replies and skips intervening SIGNAL frames", async () => {
    const srv = await startMockDbusServer({
      littleEndian: false,
      sendSignalBeforeReply: true,
      canRebootAnswer: "challenge",
    });
    const res = await directDbusCanReboot({ socketPath: srv.socketPath, uid: 1000 });
    expect(res).toEqual({ ok: true, answer: "challenge" });
  });

  it("decodes ERROR frames cleanly", async () => {
    const srv = await startMockDbusServer({
      errorOnCall: {
        name: "org.freedesktop.DBus.Error.AccessDenied",
        message: "Interactive authentication required.",
      },
    });
    const res = await directDbusCanReboot({ socketPath: srv.socketPath, uid: 1000 });
    expect(res).toEqual({
      ok: false,
      error: "org.freedesktop.DBus.Error.AccessDenied: Interactive authentication required.",
    });
  });

  it("sends Reboot(false) with boolean false (uint32 0) body", async () => {
    const srv = await startMockDbusServer();
    const res = await directDbusReboot({ socketPath: srv.socketPath, uid: 1000 });
    expect(res).toEqual({ ok: true });
    expect(srv.receivedCalls).toHaveLength(2);
    const rebootCall = srv.receivedCalls[1]!;
    expect(rebootCall.signature).toBe("b");
    expect(rebootCall.body.length).toBe(4);
    expect(rebootCall.body.readUInt32LE(0)).toBe(0);
  });

  it("reports auth rejection cleanly", async () => {
    const srv = await startMockDbusServer({ authReject: true });
    const res = await directDbusCanReboot({ socketPath: srv.socketPath, uid: 1000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("REJECTED EXTERNAL");
  });

  it("enforces timeout when server stalls", async () => {
    const srv = await startMockDbusServer({ stallAfterAuth: true });
    const res = await directDbusCanReboot({
      socketPath: srv.socketPath,
      uid: 1000,
      timeoutMs: 80,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("timed out");
  });

  it("returns an error when socket does not exist", async () => {
    const res = await directDbusCanReboot({
      socketPath: NodePath.join(NodeOS.tmpdir(), "nonexistent-hbots-dbus.sock"),
    });
    expect(res.ok).toBe(false);
  });
});
